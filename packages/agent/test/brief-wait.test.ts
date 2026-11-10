import { afterEach, describe, expect, it } from "vitest";
import { READ_SCHEMA, renderVerdict, runRead, sleepFor, WAIT_BOUNDS } from "../src/read.ts";
import { type Answer, aHome, cleanUp, json, type StandIn, standIn, stored } from "./support/stand-in-cloud.ts";

/**
 * `downtrace brief --deploy <version> --wait <duration>`: after a deploy, a coding agent asks whether it broke
 * something, and leaves this running instead of reading the brief again each turn. It reads the brief for that version
 * until its verdict is not `pending` or the duration ends, and the exit status is the verdict. The clock and the waits
 * are the test's: nothing here waits for real, except where it says so.
 */

afterEach(cleanUp);

const START = Date.parse("2026-11-09T16:00:00Z");

/** One environment's deploy, as the brief says it with `deploy=<version>`. */
function environment(
  name: string,
  verdict: string,
  says: string,
  comparison?: { rows: number; worse: number; unevaluable: number },
): unknown {
  return {
    kind: "deploy",
    id: `${name}/abc1234`,
    says,
    deploy: {
      environment: name,
      version: "abc1234",
      previous: "f00ba12",
      comparison: comparison === undefined ? null : { against: "live", thin: false, ...comparison },
      verdict,
      ...(verdict === "pending" ? { retryAfterSeconds: 60 } : {}),
    },
    next: {
      tool: "project_status",
      arguments: {},
      api: "/api/p/nidus-api/status?limit=20&operations=none",
    },
  };
}

/** A brief whose `deploy` has the verdict and the environments given. */
function briefWith(
  verdict: string,
  says: string,
  items: unknown[],
  retryAfterSeconds: number | undefined = verdict === "pending" ? 60 : undefined,
): unknown {
  return {
    version: "v1",
    headline: "Telemetry arrived in the last 24 hours from 1 of 1 environment(s).",
    deploy: {
      version: "abc1234",
      verdict,
      says,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      environments: { total: items.length, leftOut: 0, items },
    },
  };
}

const PENDING = briefWith("pending", "1 of the 1 environment(s) that ran it have no comparison to judge yet", [
  environment(
    "staging",
    "pending",
    "neither it nor the version before it has traffic to compare yet: not having a comparison is not having got nothing worse",
  ),
]);
const UNCHANGED = briefWith(
  "unchanged",
  "nothing its comparison evaluated got worse in the 1 environment(s) that ran it",
  [
    environment("staging", "unchanged", "none of the 3 rows its comparison evaluated got worse", {
      rows: 44,
      worse: 0,
      unevaluable: 41,
    }),
  ],
);
const WORSE = briefWith("worse", "it got worse in 1 of the 1 environment(s) that ran it", [
  environment("production", "worse", "2 of the 8 rows of its comparison got worse", {
    rows: 8,
    worse: 2,
    unevaluable: 1,
  }),
]);

/** A cloud that answers each read of the brief with the next of `answers`, and the last one after them. */
function inTurn(...answers: Answer[]): (path: string) => Answer {
  let read = 0;
  return (path) =>
    path.startsWith("/api/p/nidus-api/brief")
      ? (answers[Math.min(read++, answers.length - 1)] ?? json(500, {}))
      : json(404, { error: "no such page" });
}

interface Waited {
  code: number;
  stdout: string;
  stderr: string;
  /** Every wait the command asked for between two reads, in milliseconds. */
  slept: number[];
  cloud: StandIn;
}

/**
 * Runs `downtrace brief` against a stand-in that answers in turn, with a credential stored for it and a clock that
 * moves only when the command waits.
 */
async function waitFor(
  argv: string[],
  answers: Answer[],
  opts: { expiresAt?: string; timeoutMs?: number; onSleep?: (slept: number[]) => void } = {},
): Promise<Waited> {
  const cloud = await standIn(inTurn(...answers));
  const home = await aHome();
  await stored(home, [{ url: cloud.url, ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }) }]);
  let clock = START;
  const slept: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRead({
    command: "brief",
    argv,
    env: { DOWNTRACE_URL: cloud.url },
    home,
    uid: process.getuid?.(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: undefined,
    timeoutMs: opts.timeoutMs,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
      opts.onSleep?.(slept);
    },
  });
  return { code, stdout: out.join(""), stderr: err.join(""), slept, cloud };
}

const WAITING = 'downtrace brief: waiting until 2026-11-09T16:10:00Z for the verdict of "abc1234" in nidus-api\n';

describe("downtrace brief --deploy --wait", () => {
  it("reads again when the cloud says, and exits 0 when the verdict arrives and nothing got worse", async () => {
    const run = await waitFor(["--deploy", "abc1234", "--wait", "10m"], [json(200, PENDING), json(200, UNCHANGED)]);
    expect(run.code).toBe(0);
    expect(run.slept).toEqual([60_000]);
    expect(run.cloud.seen.map((r) => r.path)).toEqual([
      "/api/p/nidus-api/brief?deploy=abc1234",
      "/api/p/nidus-api/brief?deploy=abc1234",
    ]);
    expect(run.stdout).toBe("nidus-api staging abc1234: 0 rows worse, 3 unchanged, 41 not evaluated\n");
    // While it waits it says what it waits for and until when, once, on stderr; nothing else.
    expect(run.stderr).toBe(WAITING);
  });

  it("exits 1 when something got worse, and says where its rows are", async () => {
    const run = await waitFor(["--deploy", "abc1234", "--wait", "10m"], [json(200, PENDING), json(200, WORSE)]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(
      [
        "nidus-api production abc1234: 2 rows worse, 5 unchanged, 1 not evaluated",
        "  its rows: downtrace api '/api/p/nidus-api/status?limit=20&operations=none'",
        "",
      ].join("\n"),
    );
  });

  it("exits 2 with the cloud's reason when the duration ends with no verdict, its last wait cut to the deadline", async () => {
    const run = await waitFor(["--deploy=abc1234", "--wait=150s"], [json(200, PENDING)]);
    expect(run.code).toBe(2);
    expect(run.slept).toEqual([60_000, 60_000, 30_000]);
    expect(run.cloud.seen).toHaveLength(4);
    expect(run.stdout).toBe(
      [
        "nidus-api staging abc1234: no comparison: neither it nor the version before it has traffic to compare yet: not having a comparison is not having got nothing worse",
        "No verdict by 2026-11-09T16:02:30Z: 1 of the 1 environment(s) that ran it have no comparison to judge yet",
        "",
      ].join("\n"),
    );
  });

  it("exits 2 when no environment reported the version by then, and says so", async () => {
    const absent = briefWith(
      "pending",
      "no environment reported this version in the last 24 hours: an instrumentation running it has not sent a batch yet, or it reports another version",
      [],
    );
    const run = await waitFor(["--deploy", "abc1234", "--wait", "2m"], [json(200, absent)]);
    expect(run.code).toBe(2);
    expect(run.cloud.seen).toHaveLength(3);
    expect(run.stdout).toBe(
      "nidus-api abc1234: no environment reported this version in the last 24 hours: an instrumentation running it has not sent a batch yet, or it reports another version\n" +
        "No verdict by 2026-11-09T16:02:00Z.\n",
    );
  });

  it("exits 2 at once when the verdict is that no comparison will come", async () => {
    const none = briefWith("none", "1 of the 1 environment(s) that ran it will have no comparison, and each says why", [
      environment(
        "staging",
        "none",
        "it is the first version this environment ran, so there is nothing before it to compare it with",
      ),
    ]);
    const run = await waitFor(["--deploy", "abc1234", "--wait", "10m"], [json(200, none)]);
    expect(run.code).toBe(2);
    expect(run.slept).toEqual([]);
    expect(run.stdout).toBe(
      "nidus-api staging abc1234: no comparison: it is the first version this environment ran, so there is nothing before it to compare it with\n",
    );
  });

  it("waits what the cloud says within its bounds, and the default when it says nothing", async () => {
    for (const [retry, waited] of [
      [1, WAIT_BOUNDS.minMs],
      [90, 90_000],
      [3_600, WAIT_BOUNDS.maxMs],
      [undefined, WAIT_BOUNDS.defaultMs],
      [-5, WAIT_BOUNDS.defaultMs],
    ] as const) {
      const pending = briefWith("pending", "waiting", [], retry);
      const run = await waitFor(["--deploy", "abc1234", "--wait", "1h"], [json(200, pending), json(200, UNCHANGED)]);
      expect(run.slept, String(retry)).toEqual([waited]);
      expect(run.code, String(retry)).toBe(0);
    }
    expect(WAIT_BOUNDS).toEqual({ minMs: 5_000, maxMs: 300_000, defaultMs: 60_000, longestMs: 86_400_000 });
  });

  it("prints the cloud's last answer as it came with --json, and exits with its verdict", async () => {
    const worse = await waitFor(
      ["--deploy", "abc1234", "--wait", "10m", "--json"],
      [json(200, PENDING), json(200, WORSE)],
    );
    expect(worse.code).toBe(1);
    expect(worse.stdout).toBe(`${JSON.stringify(WORSE)}\n`);
    expect(worse.stderr).toBe(WAITING);

    const late = await waitFor(["--deploy", "abc1234", "--wait", "1m", "--json"], [json(200, PENDING)]);
    expect(late.code).toBe(2);
    expect(late.stdout).toBe(`${JSON.stringify(PENDING)}\n`);
  });

  it("reads once with --deploy alone, and says nothing while it does", async () => {
    const run = await waitFor(["--deploy", "abc1234"], [json(200, PENDING), json(200, UNCHANGED)]);
    expect(run.code).toBe(2);
    expect(run.cloud.seen).toHaveLength(1);
    expect(run.slept).toEqual([]);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("No verdict by 2026-11-09T16:00:00Z: 1 of the 1 environment(s)");

    const done = await waitFor(["--deploy", "abc1234", "--since", "2026-11-09T15:00:00Z"], [json(200, UNCHANGED)]);
    expect(done.code).toBe(0);
    expect(done.cloud.seen.map((r) => r.path)).toEqual([
      "/api/p/nidus-api/brief?since=2026-11-09T15%3A00%3A00Z&deploy=abc1234",
    ]);
  });
});

describe("what downtrace brief --deploy says when a read fails", () => {
  it("reads again after a request that timed out, a cloud that failed or one it could not reach", async () => {
    const run = await waitFor(
      ["--deploy", "abc1234", "--wait", "10m"],
      [json(200, PENDING), "hang", json(503, { error: "restarting" }), json(200, UNCHANGED)],
      { timeoutMs: 100 },
    );
    expect(run.code).toBe(0);
    expect(run.slept).toEqual([60_000, WAIT_BOUNDS.defaultMs, WAIT_BOUNDS.defaultMs]);
    expect(run.stdout).toBe("nidus-api staging abc1234: 0 rows worse, 3 unchanged, 41 not evaluated\n");
  });

  it("exits 2 with the last failure when the duration ends on one", async () => {
    const run = await waitFor(["--deploy", "abc1234", "--wait", "1m"], ["hang"], { timeoutMs: 100 });
    expect(run.code).toBe(2);
    expect(run.cloud.seen).toHaveLength(2);
    expect(run.stderr).toBe(
      `${WAITING.replace("16:10:00Z", "16:01:00Z")}downtrace brief: no verdict of "abc1234" by 2026-11-09T16:01:00Z: the cloud at ${run.cloud.url} did not answer within 0.1 s\n`,
    );
  });

  it("exits 2, never 1, when the cloud refuses, with its words and without reading again", async () => {
    const run = await waitFor(
      ["--deploy", "abc1234", "--wait", "10m"],
      [json(200, PENDING), json(403, { error: "this credential's level is read and this needs operate" })],
    );
    expect(run.code).toBe(2);
    expect(run.cloud.seen).toHaveLength(2);
    expect(run.stderr).toContain("answered 403: this credential's level is read");

    const json400 = await waitFor(
      ["--deploy", "abc1234", "--json"],
      [json(400, { error: "`deploy` must be a deployed version, of 1 to 128 characters" })],
    );
    expect(json400.code).toBe(2);
    expect(JSON.parse(json400.stdout)).toMatchObject({ schema: READ_SCHEMA, reason: "refused", httpStatus: 400 });
  });

  it("stops when the credential stops being taken while it waits, and says how to get another", async () => {
    const refused = await waitFor(
      ["--deploy", "abc1234", "--wait", "10m"],
      [json(200, PENDING), { status: 401, body: "unauthorized\n" }],
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      "the credential downtrace login stored for nidus-api is expired, revoked or unknown",
    );

    // One that expires while it waits is not sent once it has.
    const expired = await waitFor(["--deploy", "abc1234", "--wait", "10m"], [json(200, PENDING)], {
      expiresAt: "2026-11-09T16:01:30Z",
    });
    expect(expired.code).toBe(2);
    expect(expired.cloud.seen).toHaveLength(2);
    expect(expired.stderr).toContain("expired at 2026-11-09T16:01:30Z, so it was not sent");
    expect(expired.stderr).not.toContain("dtr_stored");
  });

  it("exits 2 when the cloud's brief says no verdict, or one this command does not know", async () => {
    const older = await waitFor(["--deploy", "abc1234", "--wait", "10m"], [json(200, { headline: "h" })]);
    expect(older.code).toBe(2);
    expect(older.stderr).toContain(`says no verdict of "abc1234": it is older than this command`);
    expect(older.cloud.seen).toHaveLength(1);

    const later = await waitFor(["--deploy", "abc1234"], [json(200, briefWith("mixed", "s", []))]);
    expect(later.code).toBe(2);
    expect(later.stderr).toContain('a verdict this command does not know: "mixed"');
    const inherited = await waitFor(["--deploy", "abc1234"], [json(200, briefWith("toString", "s", []))]);
    expect(inherited.code).toBe(2);
  });

  it("ends when it is interrupted while it waits, and exits 2", async () => {
    const abort = new AbortController();
    const cloud = await standIn(inTurn(json(200, PENDING)));
    const home = await aHome();
    await stored(home, [{ url: cloud.url }]);
    const err: string[] = [];
    let sleeping: () => void = () => {};
    const asleep = new Promise<void>((resolve) => {
      sleeping = resolve;
    });
    const run = runRead({
      command: "brief",
      argv: ["--deploy", "abc1234", "--wait", "1h"],
      env: { DOWNTRACE_URL: cloud.url },
      home,
      uid: process.getuid?.(),
      stdout: () => {},
      stderr: (text) => err.push(text),
      signal: abort.signal,
      now: () => START,
      // The command's own wait, which Ctrl-C has to end: this one is a real timer, a minute long.
      sleep: (ms, signal) => {
        sleeping();
        return sleepFor(ms, signal);
      },
    });
    await asleep;
    // A test that ends at all is one whose wait the signal ended.
    abort.abort();
    expect(await run).toBe(2);
    expect(err.join("")).toContain('interrupted while waiting for the verdict of "abc1234"');
    expect(cloud.seen).toHaveLength(1);
  });

  it.each([
    [["--wait", "10m"], "--wait waits for a deploy's verdict: name its version with --deploy"],
    [["--deploy", "abc1234", "--wait", "ten"], "--wait is a duration of 24 hours at most"],
    [["--deploy", "abc1234", "--wait", "25h"], "--wait is a duration of 24 hours at most"],
    [["--deploy", "abc1234", "--wait", "-1m"], "--wait is a duration of 24 hours at most"],
    [["--deploy"], "--deploy needs a value"],
  ])("refuses %j with its usage, and sends nothing", async (argv, says) => {
    const run = await waitFor(argv, [json(200, UNCHANGED)]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(says);
    expect(run.stderr).toContain("Usage: downtrace");
    expect(run.cloud.seen).toEqual([]);
  });
});

describe("the wait between two reads", () => {
  it("ends when its time comes, and at once for a signal that aborted before it", async () => {
    await sleepFor(1, undefined);
    await sleepFor(60_000, AbortSignal.abort());
  });
});

describe("a deploy's verdict as text", () => {
  it("prints what there is of a verdict that lacks a part, and never fails for it", () => {
    expect(renderVerdict(undefined, "x")).toBe("x: no environment said\n");
    expect(renderVerdict({ version: "v", environments: { items: [{}] } }, "x")).toBe("x v: no comparison\n");
    expect(
      renderVerdict(
        { version: "v", says: "s", environments: { total: 3, items: [{ deploy: { environment: "e" } }] } },
        "x",
        "T",
      ),
    ).toBe(
      "x e v: no comparison\n… and 2 more environment(s): downtrace brief --project x --deploy v --json\nNo verdict by T: s\n",
    );
  });

  it("prints the cloud's words without what a terminal would act on", () => {
    const text = renderVerdict(
      {
        version: "v\u001b[2J",
        environments: { items: [{ says: "s\u009b", deploy: { environment: "e‮", verdict: "none" } }] },
      },
      "x",
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it looks for.
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮]/);
  });
});
