import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE } from "../src/check/args.ts";
import { credentialsPath, storeCredential } from "../src/login/store.ts";
import { READ_SCHEMA, renderBrief, runRead } from "../src/read.ts";
import { type Answer, aHome, cleanUp, json, type StandIn, standIn, stored } from "./support/stand-in-cloud.ts";

/**
 * `downtrace brief` against a stand-in cloud that answers `GET /api/p/{slug}/brief` as the cloud does: the brief
 * as JSON, with `--json`, or as a short text a coding agent reads first; and the credential it sends, which is
 * `DOWNTRACE_TOKEN` or the one `downtrace login` stored for the cloud and the project, and no other.
 */

afterEach(cleanUp);

/** A brief in the shape the cloud answers, cut to what the text reads and a little more. */
const BRIEF = {
  version: "v1",
  preparedAt: "2026-11-09T16:04:00Z",
  scope: { project: "nidus-api" },
  headline:
    "Telemetry arrived in the last 24 hours from 1 of 1 environment(s). 1 open finding(s); 1 error(s) first seen.",
  telemetry: { arrivedSince: true, environments: { total: 1, leftOut: 0, items: [] } },
  attention: {
    total: 3,
    leftOut: 1,
    items: [
      {
        kind: "finding",
        id: "42",
        says: "slower, or failing more, than this route usually is",
        finding: { environment: "production", endpoint: "GET /orders" },
        next: {
          tool: "read_report",
          arguments: { project: "nidus-api", finding: "42" },
          api: "/api/p/nidus-api/findings/42/report",
        },
      },
      {
        kind: "error",
        id: "9f3c",
        says: "an error first seen in this window",
        error: { fromService: { text: "invalid input syntax for type timestamp with time zone" } },
        next: { tool: "read_error", arguments: {}, api: "/api/p/nidus-api/errors/9f3c" },
      },
    ],
  },
  unknowns: { total: 0, leftOut: 0, items: [] },
  next: {
    tool: "changes_since",
    arguments: { project: "nidus-api", since: "2026-11-09T16:04:00Z" },
    api: "/api/p/nidus-api/changes?since=2026-11-09T16%3A04%3A00Z",
  },
};

const briefOf = (body: unknown = BRIEF): ((path: string) => Answer) => {
  return (path) => (path.startsWith("/api/p/nidus-api/brief") ? json(200, body) : json(404, { error: "no such page" }));
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function brief(
  argv: string[],
  opts: { home: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; now?: number },
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRead({
    command: "brief",
    argv,
    env: opts.env ?? {},
    home: opts.home,
    uid: process.getuid?.(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    now: () => opts.now ?? Date.parse("2026-11-09T16:00:00Z"),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** A cloud and a home whose credentials file holds one credential of `nidus-api` for it. */
async function connected(answer: (path: string) => Answer = briefOf()): Promise<{ cloud: StandIn; home: string }> {
  const cloud = await standIn(answer);
  const home = await aHome();
  await stored(home, [{ url: cloud.url }]);
  return { cloud, home };
}

describe("downtrace brief", () => {
  it("prints the cloud's answer as it came with --json, read with the credential login stored", async () => {
    const { cloud, home } = await connected();
    const run = await brief(["--json"], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${JSON.stringify(BRIEF)}\n`);
    expect(run.stderr).toBe("");
    expect(cloud.seen).toEqual([{ method: "GET", path: "/api/p/nidus-api/brief", authorization: "Bearer dtr_stored" }]);
  });

  it("prints the headline, what needs attention and where to read next, short, as text", async () => {
    const { cloud, home } = await connected();
    const run = await brief([], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      [
        `nidus-api: ${BRIEF.headline}`,
        "",
        "Needs attention (2 of 3):",
        '  finding "42": slower, or failing more, than this route usually is',
        "    downtrace api /api/p/nidus-api/findings/42/report",
        '  error "9f3c": an error first seen in this window',
        "    downtrace api /api/p/nidus-api/errors/9f3c",
        "",
        "Next: downtrace api '/api/p/nidus-api/changes?since=2026-11-09T16%3A04%3A00Z'",
        "Routes, hotspots, telemetry and what the brief cannot say: downtrace brief --project nidus-api --json",
        "",
      ].join("\n"),
    );
    // What the service sent is the cloud's to show under `fromService`, and the text does not repeat it.
    expect(run.stdout).not.toContain("invalid input syntax");
    expect(run.stdout).not.toContain("dtr_stored");
  });

  it("prints what there is of a brief that lacks a part, and never fails for it", async () => {
    expect(renderBrief({}, "nidus-api")).toBe(
      "Brief of nidus-api.\nRoutes, hotspots, telemetry and what the brief cannot say: downtrace brief --project nidus-api --json\n",
    );
    expect(renderBrief([], "x")).toContain("Brief of x.");
    expect(renderBrief({ headline: "h", attention: { items: [] } }, "x")).toContain(
      "x: h\n\nNeeds attention: nothing listed in this brief.\n",
    );
    // An attention that is a plain list, an item with no next, with nothing but a kind, or that is not an object.
    const text = renderBrief(
      { headline: "h", attention: [{ kind: "deploy", says: "the newest version" }, { kind: "coverage" }, "odd", null] },
      "x",
    );
    expect(text).toContain("Needs attention:\n  deploy: the newest version\n  coverage\n  item\n  item\n");
    expect(text).not.toContain("downtrace api");
  });

  it("prints the cloud's sentences without what a terminal would act on, and an id as data", () => {
    const text = renderBrief(
      {
        headline: "a\u001b[2Jb\u202ec",
        attention: [
          { kind: "deploy", id: 'production/v1 "x"\u0007', says: "s\u009b", next: { api: "/api/p/x/a b'c" } },
        ],
      },
      "x",
    );
    expect(text).toContain("x: a[2Jbc\n");
    expect(text).toContain('  deploy "production/v1 \\"x\\"": s\n');
    expect(text).toContain("    downtrace api '/api/p/x/a b'\\''c'\n");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it looks for.
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
  });

  it("asks for what is new since --since, and the project --project names", async () => {
    const cloud = await standIn(() => json(200, BRIEF));
    const home = await aHome();
    await stored(home, [{ url: cloud.url }, { url: cloud.url, project: "shop-api", token: "dtr_shop" }]);
    const run = await brief(["--project", "shop-api", "--since=2026-11-09T15:00:00+01:00", "--json"], {
      home,
      env: { DOWNTRACE_URL: cloud.url },
    });
    expect(run.code).toBe(0);
    expect(cloud.seen).toEqual([
      {
        method: "GET",
        path: "/api/p/shop-api/brief?since=2026-11-09T15%3A00%3A00%2B01%3A00",
        authorization: "Bearer dtr_shop",
      },
    ]);
  });

  it("reads --url, before DOWNTRACE_URL, with the credential stored for that cloud", async () => {
    const named = await standIn(briefOf());
    const other = await standIn(briefOf());
    const home = await aHome();
    await stored(home, [
      { url: named.url, token: "dtr_named" },
      { url: other.url, token: "dtr_other" },
    ]);
    const run = await brief(["--url", `${named.url}/`, "--json"], { home, env: { DOWNTRACE_URL: other.url } });
    expect(run.code).toBe(0);
    expect(named.seen.map((r) => r.authorization)).toEqual(["Bearer dtr_named"]);
    expect(other.seen).toEqual([]);
  });

  it("refuses a cloud over http:// that is not this machine, before reading any credential", async () => {
    const home = await aHome();
    const run = await brief([], { home, env: { DOWNTRACE_URL: "http://cloud.example" } });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("http:// only for localhost");
  });
});

describe("the credential downtrace brief sends", () => {
  it("is DOWNTRACE_TOKEN when it is set, and not the stored one", async () => {
    const { cloud, home } = await connected();
    const run = await brief(["--json"], { home, env: { DOWNTRACE_URL: cloud.url, DOWNTRACE_TOKEN: " dtr_env " } });
    expect(run.code).toBe(0);
    // The stored entry names the project, which the variable does not.
    expect(cloud.seen).toEqual([{ method: "GET", path: "/api/p/nidus-api/brief", authorization: "Bearer dtr_env" }]);
  });

  it("is not DOWNTRACE_TOKEN when that holds an ingestion token, which reads nothing", async () => {
    const { cloud, home } = await connected();
    const run = await brief(["--json"], { home, env: { DOWNTRACE_URL: cloud.url, DOWNTRACE_TOKEN: "dt_ingest" } });
    expect(run.code).toBe(0);
    expect(cloud.seen.map((r) => r.authorization)).toEqual(["Bearer dtr_stored"]);

    const empty = await aHome();
    const none = await brief([], { home: empty, env: { DOWNTRACE_URL: cloud.url, DOWNTRACE_TOKEN: "dt_ingest" } });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("DOWNTRACE_TOKEN is an ingestion token, which reads nothing, so it is not sent");
    expect(none.stderr).not.toContain("dt_ingest");
    expect(cloud.seen).toHaveLength(1);
  });

  it("is the only one stored for the cloud when no project is named, and several are named back", async () => {
    const cloud = await standIn(briefOf());
    const elsewhere = await standIn(briefOf());
    const home = await aHome();
    // Another cloud's credential does not make the project ambiguous.
    await stored(home, [{ url: cloud.url }, { url: elsewhere.url, project: "shop-api" }]);
    expect((await brief(["--json"], { home, env: { DOWNTRACE_URL: cloud.url } })).code).toBe(0);

    await stored(home, [{ url: cloud.url, project: "shop-api" }]);
    const run = await brief([], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`stored credentials of several projects at ${cloud.url}: nidus-api, shop-api`);
    expect(run.stderr).toContain("--project");
    expect(cloud.seen).toHaveLength(1);
  });

  it("is none when login stored none for the project, and the command says how to get one", async () => {
    const cloud = await standIn(briefOf());
    const home = await aHome();
    const nothing = await brief([], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(nothing.code).toBe(2);
    expect(nothing.stderr).toBe(
      `downtrace brief: there is no DOWNTRACE_TOKEN, and downtrace login stored no credential for a project at ${cloud.url}: ` +
        `run \`npx @downtrace/agent login --project '<slug>' --url ${cloud.url}\`\n`,
    );

    // The same project at another cloud is another credential, and is not sent here.
    await stored(home, [{ url: "https://elsewhere.example", project: "nidus-api" }]);
    await stored(home, [{ url: cloud.url, project: "shop-api" }]);
    const other = await brief(["--project", "nidus-api"], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(other.code).toBe(2);
    expect(other.stderr).toContain(
      `downtrace login stored no credential for nidus-api at ${cloud.url} (it stored ones of shop-api)`,
    );
    expect(other.stderr).toContain(`login --project nidus-api --url ${cloud.url}`);
    expect(cloud.seen).toEqual([]);
  });

  it("is not an expired one, which the command says to renew, as it was asked for", async () => {
    const cloud = await standIn(briefOf());
    const home = await aHome();
    await stored(home, [
      { url: cloud.url, environment: "staging", level: "operate", expiresAt: "2026-11-09T15:00:00Z" },
    ]);
    const run = await brief([], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      `the credential downtrace login stored for nidus-api at ${cloud.url} expired at 2026-11-09T15:00:00Z, so it was not sent`,
    );
    expect(run.stderr).toContain(
      `run \`npx @downtrace/agent login --project nidus-api --env staging --level operate --url ${cloud.url}\` again`,
    );
    expect(run.stderr).not.toContain("dtr_stored");
    expect(cloud.seen).toEqual([]);
  });

  it("is not read from a file others can read, and the command says why", async () => {
    const { cloud, home } = await connected();
    await chmod(credentialsPath({}, home), 0o644);
    const run = await brief([], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("can be read or written by other users, so it is not used");
    expect(cloud.seen).toEqual([]);
  });

  it("is under $XDG_CONFIG_HOME when it names a directory", async () => {
    const cloud = await standIn(briefOf());
    const config = await aHome();
    const home = await aHome();
    await storeCredential(
      {
        url: cloud.url,
        project: "nidus-api",
        environment: "production",
        environments: [],
        level: "read",
        id: "c",
        token: "dtr_xdg",
        onBehalfOf: "",
        expiresAt: "",
      },
      { path: credentialsPath({ XDG_CONFIG_HOME: config }, home), uid: process.getuid?.() },
    );
    // A credential in the home is not the one read when $XDG_CONFIG_HOME names another directory.
    await stored(home, [{ url: cloud.url, token: "dtr_home" }]);
    const run = await brief(["--json"], { home, env: { DOWNTRACE_URL: cloud.url, XDG_CONFIG_HOME: config } });
    expect(run.code).toBe(0);
    expect(cloud.seen.map((r) => r.authorization)).toEqual(["Bearer dtr_xdg"]);
  });
});

describe("what downtrace brief says when it cannot read", () => {
  it("exits 1 with the cloud's own words when the cloud refuses", async () => {
    for (const [answer, says] of [
      [{ status: 401, body: "unauthorized\n" }, "answered 401: unauthorized"],
      [
        json(403, { error: "this credential's level is read and this needs operate" }),
        "answered 403: this credential's level is read",
      ],
      [json(404, { error: "no such project" }), "answered 404: no such project"],
      [
        json(400, { error: "`since` must be an RFC 3339 instant" }),
        "answered 400: `since` must be an RFC 3339 instant",
      ],
    ] as const) {
      const { cloud, home } = await connected(() => answer);
      const run = await brief([], { home, env: { DOWNTRACE_URL: cloud.url } });
      expect(run.code, says).toBe(1);
      expect(run.stderr, says).toContain(`downtrace brief: the cloud at ${cloud.url} ${says}`);
      expect(run.stdout, says).toBe("");
      expect(run.stderr, says).not.toContain("dtr_stored");
    }
  });

  it("says, of a stored credential the cloud does not take, to run login again", async () => {
    const { cloud, home } = await connected(() => ({ status: 401, body: "unauthorized\n" }));
    const run = await brief([], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.stderr).toContain("the credential downtrace login stored for nidus-api is expired, revoked or unknown");
    expect(run.stderr).toContain(`run \`npx @downtrace/agent login --project nidus-api --env production --level read`);
    const env = await brief([], { home, env: { DOWNTRACE_URL: cloud.url, DOWNTRACE_TOKEN: "dtr_secret" } });
    expect(env.stderr).toContain("DOWNTRACE_TOKEN is expired, revoked or unknown to it");
    expect(env.stderr).not.toContain("dtr_secret");
  });

  it("exits 2 when nothing could be read: a failing cloud, an answer that is not JSON, a redirect", async () => {
    const target = await standIn(() => json(200, BRIEF));
    for (const [answer, says] of [
      [json(500, { error: "could not read the project's brief" }), "answered 500: could not read the project's brief"],
      [{ status: 200, body: "<html>sign in</html>" }, "answered 200 with something that is not JSON"],
      [{ status: 200, body: '{"headline": "cut' }, "answered 200 with something that is not JSON"],
      [
        { status: 302, body: "", headers: { location: `${target.url}/api/p/nidus-api/brief` } },
        "answered 302, a redirect",
      ],
    ] as const) {
      const { cloud, home } = await connected(() => answer);
      const run = await brief(["--json"], { home, env: { DOWNTRACE_URL: cloud.url } });
      expect(run.code, says).toBe(2);
      expect(JSON.parse(run.stdout).message, says).toContain(says);
    }
    // The redirect was not followed, so the credential went to the cloud configured and nowhere else.
    expect(target.seen).toEqual([]);
  });

  it("waits a bounded time for a cloud that does not answer, and exits 2", async () => {
    const { cloud, home } = await connected(() => "hang");
    const run = await brief([], { home, env: { DOWNTRACE_URL: cloud.url }, timeoutMs: 100 });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`the cloud at ${cloud.url} did not answer within 0.1 s`);
  });

  it("waits 30 seconds unless told otherwise", async () => {
    const { READ_TIMEOUT_MS } = await import("../src/read.ts");
    expect(READ_TIMEOUT_MS).toBe(30_000);
    expect(USAGE).toContain("does not answer in 30 s");
  });

  it("exits 2 for a cloud it cannot reach, and when it is interrupted", async () => {
    const cloud = await standIn(briefOf());
    const home = await aHome();
    await stored(home, [{ url: "http://127.0.0.1:9" }]);
    const unreachable = await brief([], { home, env: { DOWNTRACE_URL: "http://127.0.0.1:9" } });
    expect(unreachable.code).toBe(2);
    expect(unreachable.stderr).toContain("could not reach the cloud at http://127.0.0.1:9");

    await stored(home, [{ url: cloud.url }]);
    const interrupted = await brief([], { home, env: { DOWNTRACE_URL: cloud.url }, signal: AbortSignal.abort() });
    expect(interrupted.code).toBe(2);
    expect(interrupted.stderr).toContain("interrupted before the cloud answered");
  });

  it("prints a failure as JSON with --json, and the cloud's refusal with its status", async () => {
    const { cloud, home } = await connected(() => json(404, { error: "no such project" }));
    const run = await brief(["--json"], { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      schema: READ_SCHEMA,
      status: "failed",
      reason: "refused",
      httpStatus: 404,
      message: `the cloud at ${cloud.url} answered 404: no such project`,
    });
    const empty = await aHome();
    const none = await brief(["--json"], { home: empty, env: { DOWNTRACE_URL: cloud.url } });
    expect(none.code).toBe(2);
    expect(JSON.parse(none.stdout)).toMatchObject({ schema: READ_SCHEMA, status: "failed", reason: "no-credential" });
  });

  it.each([
    [["--bogus"], "unknown option --bogus for brief"],
    [["--project"], "--project needs a value"],
    [["--project", "../admin"], 'not a project\'s slug: "../admin"'],
    [["stray"], 'unexpected "stray"'],
  ])("refuses %j with its usage, and sends nothing", async (argv, says) => {
    const { cloud, home } = await connected();
    const run = await brief(argv, { home, env: { DOWNTRACE_URL: cloud.url } });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(says);
    expect(run.stderr).toContain("Usage: downtrace");
    expect(cloud.seen).toEqual([]);
  });

  it("prints its usage", async () => {
    const run = await brief(["--help"], { home: await aHome() });
    expect(run).toEqual({ code: 0, stdout: USAGE, stderr: "" });
  });
});

describe("downtrace brief, as a user runs it", () => {
  it("is a command of downtrace, which reads the credentials file of the user's configuration", async () => {
    const { cloud, home } = await connected();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, DOWNTRACE_URL: cloud.url };
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const run = await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "brief", "--json"], { env, timeout: 30_000 });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(BRIEF);
    expect(cloud.seen.map((r) => r.authorization)).toEqual(["Bearer dtr_stored"]);
  });
});
