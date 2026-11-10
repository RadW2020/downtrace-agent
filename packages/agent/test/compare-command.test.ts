import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/check/command.ts";
import { compareRuns } from "../src/check/compare.ts";
import { COMPARE_SCHEMA, type CompareReport } from "../src/check/compare-command.ts";
import { readRun } from "../src/check/read.ts";
import { judge } from "../src/check/run.ts";
import { batch, endpoint, fileOf, interval, operation, profile, profileEndpoint } from "./support/check-batches.ts";
import { REGISTER_URL } from "./support/check-project.ts";

/**
 * `downtrace compare`: `check`'s verdict over two files `DOWNTRACE_INSPECT` wrote, recorded however the project can.
 * The verdict is the same code's (`judge`), so the tests below hold it to that: the same routes for the same tallies,
 * by composition and never by latency, the same exit status, and nothing presented as unchanged that was not
 * evaluated.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function room(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "downtrace-compare-"));
  dirs.push(made);
  return made;
}

const LOOKUP = (n: number, totalMs = n) =>
  operation("query", "q-user", 'select * from "users" where "id" = ?', n, totalMs);

/**
 * An application's file: `GET /users/:id` served three times, each request looking its user up `lookups` times and
 * taking `meanMs`; `GET /health`, which ran nothing.
 */
function recorded(lookups: number, meanMs = 5): string {
  return fileOf(
    batch("app", {
      intervals: [
        interval(1000, 1000, [
          endpoint("GET", "/users/:id", 3, { requestsWithCalls: 3, meanMs }),
          endpoint("GET", "/health", 1),
        ]),
      ],
      profile: profile(1000, 1000, [profileEndpoint("GET", "/users/:id", [LOOKUP(3 * lookups, 3 * lookups * meanMs)])]),
    }),
  );
}

async function compare(files: { base?: string; change?: string }, args: string[] = [], argv?: string[]) {
  const dir = await room();
  if (files.base !== undefined) await writeFile(join(dir, "base.jsonl"), files.base);
  if (files.change !== undefined) await writeFile(join(dir, "change.jsonl"), files.change);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv: argv ?? ["compare", ...args, "base.jsonl", "change.jsonl"],
    env: { PATH: process.env.PATH },
    cwd: dir,
    tmpRoot: tmpdir(),
    registerUrl: REGISTER_URL,
    version: "9.9.9",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: undefined,
  });
  const stdout = out.join("");
  return { code, stdout, stderr: err.join(""), json: (): CompareReport => JSON.parse(stdout) as CompareReport };
}

describe("the verdict of downtrace compare", () => {
  it("is check's: the same routes, from the same code, for the same two tallies", async () => {
    const said = (await compare({ base: recorded(1), change: recorded(4) }, ["--json"])).json();
    const tallies = { base: readRun(recorded(1)), change: readRun(recorded(4)) };
    const files = { base: "base.jsonl", change: "change.jsonl" };
    expect(said.routes).toEqual(compareRuns(tallies.base, tallies.change));
    expect(said.routes).toEqual(
      judge(tallies, { declared: [], dependencies: undefined, wording: { side: files, file: files, unprofiled: "" } })
        .routes,
    );
  });

  it("calls a route worse when a query multiplied, in check's words, and ends with check's 1", async () => {
    const { code, stdout } = await compare({ base: recorded(1), change: recorded(4) });
    expect(code).toBe(1);
    expect(stdout).toContain("downtrace compare: change.jsonl against base.jsonl");
    expect(stdout).toContain("  base   base.jsonl  ·  4 requests on 2 routes, 1 process wrote 1 batch");
    expect(stdout).toContain("1 of 2 routes evaluated: 1 worse, 0 unchanged.");
    expect(stdout).toContain("Worse (1)\n  GET /users/:id   3 requests in the base, 3 in the change");
    expect(stdout).toContain('    multiplied select * from "users" where "id" = ?  [query q-user]  1 -> 4 per request');
    expect(stdout).toContain("Not evaluated (1)\n  GET /health");
    expect(stdout).toContain("Durations are shown and never judged");
  });

  it("judges by composition and never by latency: the same queries ten times slower are unchanged, and end with 0", async () => {
    const said = await compare({ base: recorded(2, 5), change: recorded(2, 50) }, ["--json"]);
    expect(said.code).toBe(0);
    expect(said.json()).toMatchObject({
      schema: COMPARE_SCHEMA,
      status: "compared",
      summary: { worse: 0, unchanged: 1, notEvaluated: 1 },
    });
    expect(said.json().routes[0]?.meanRequestMs).toEqual({ base: 5, change: 50 });
  });

  it("changes no route when both sides are the same file", async () => {
    const said = await compare({ base: recorded(4), change: recorded(4) }, ["--json"]);
    expect(said.code).toBe(0);
    const routes = said.json().routes;
    expect(routes.filter((one) => one.verdict === "worse")).toEqual([]);
    for (const one of routes.filter((each) => each.verdict === "unchanged")) {
      for (const moved of one.operations) expect(moved.change, moved.id).toBe("unchanged");
    }
    expect(routes.map((one) => [one.id, one.verdict])).toEqual([
      ["GET /users/:id", "unchanged"],
      ["GET /health", "not-evaluated"],
    ]);
  });

  it("gives no green result when no route could be evaluated, and ends with 2", async () => {
    const nothing = fileOf(batch("app", { intervals: [interval(1000, 1000, [endpoint("GET", "/health", 2)])] }));
    const said = await compare({ base: nothing, change: nothing }, ["--json"]);
    expect(said.code).toBe(2);
    expect(said.json()).toMatchObject({
      status: "failed",
      failure: { code: "nothing-evaluated", side: null, line: null },
      routes: [{ id: "GET /health", verdict: "not-evaluated", reasons: [{ code: "nothing-observed" }] }],
    });
  });

  it("says, when no route could be evaluated, why each route the JSON carries was not, in check's words", async () => {
    const nothing = fileOf(
      batch("app", {
        intervals: [
          interval(1000, 1000, [endpoint("GET", "/health", 2), endpoint("GET", "/slow", 3, { requestsWithCalls: 3 })]),
        ],
      }),
    );
    const { routes } = (await compare({ base: nothing, change: nothing }, ["--json"])).json();
    const { code, stdout } = await compare({ base: nothing, change: nothing });
    expect(code).toBe(2);
    expect(stdout).toContain("downtrace compare: no comparison could be made");
    expect(stdout).toContain(`Not evaluated (${routes.length})`);
    expect(routes.map((route) => route.id)).toEqual(["GET /health", "GET /slow"]);
    for (const route of routes) {
      const block = [`  ${route.id}`, ...route.reasons.map((reason) => `    ${reason.message}`)].join("\n");
      expect(stdout, route.id).toContain(`\n${block}\n`);
    }
    expect(stdout).not.toMatch(/unchanged/i);
  });

  it("says the lines it left out of each side, and counts them in a note", async () => {
    const { code, stdout } = await compare({ base: recorded(1), change: `oops\n${recorded(1)}` });
    expect(code).toBe(0);
    expect(stdout).toContain(
      "  change change.jsonl  ·  4 requests on 2 routes, 1 process wrote 1 batch  ·  left out: line 1",
    );
    expect(stdout).toContain("1 line of change.jsonl could not be read and was left out.");
  });
});

describe("downtrace compare, when a side cannot be read", () => {
  it("says which file and which line, and ends with 2 and no stack", async () => {
    const later = { ...(JSON.parse(recorded(1)) as Record<string, unknown>), protocol: "2.0.0" };
    const { code, stdout, stderr } = await compare({
      base: recorded(1),
      change: `${recorded(1)}\n${JSON.stringify(later)}`,
    });
    expect(code).toBe(2);
    expect(stderr).toBe("");
    expect(stdout).toContain("downtrace compare: no comparison could be made");
    expect(stdout).toContain('change: line 2 of change.jsonl cannot be read: it is a batch of protocol "2.0.0"');
    expect(stdout).not.toMatch(/\n\s+at /);
  });

  it("says a base that is no file DOWNTRACE_INSPECT wrote, as JSON", async () => {
    const said = await compare({ base: '{"name":"my-app"}\n', change: recorded(1) }, ["--json"]);
    expect(said.code).toBe(2);
    expect(said.json()).toMatchObject({
      schema: COMPARE_SCHEMA,
      status: "failed",
      base: null,
      change: null,
      failure: { code: "not-inspection-file", side: "base", line: 1 },
    });
  });

  it("says a file that is not there", async () => {
    const said = await compare({ base: recorded(1) }, ["--json"]);
    expect(said.code).toBe(2);
    expect(said.json()).toMatchObject({
      failure: {
        code: "unreadable-file",
        side: "change",
        message: "change.jsonl could not be read: there is no such file",
      },
      base: { file: "base.jsonl", requests: 4 },
    });
  });

  it("says a side in which no request was counted, which is no comparison", async () => {
    const said = await compare({ base: fileOf(batch("app", {})), change: recorded(1) }, ["--json"]);
    expect(said.code).toBe(2);
    expect(said.json().failure).toMatchObject({ code: "no-requests", side: "base" });
  });
});

describe("the command line of report and compare", () => {
  it.each([
    [["compare", "only-one.jsonl"], "compare reads two files: downtrace compare <base file> <change file>"],
    [["compare", "a", "b", "c"], "compare reads two files"],
    [["report"], "report reads one file: downtrace report <file>"],
    [["report", "a", "b"], "report reads one file"],
    [["report", "--frobnicate", "a"], "unknown option --frobnicate for report"],
    [["compare", "-x", "a", "b"], "unknown option -x for compare"],
  ])("refuses %j on stderr, with the usage, and ends with 2", async (argv, said) => {
    const { code, stdout, stderr } = await compare({}, [], argv);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(said);
    expect(stderr).toContain("Usage: downtrace check");
  });
});
