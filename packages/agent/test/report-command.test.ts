import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALLS_PER_REQUEST_BOUNDARIES_V0 } from "@downtrace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/check/command.ts";
import { readRun } from "../src/check/read.ts";
import {
  medianBucket,
  ROUTE_REPORT_SCHEMA,
  type RouteReport,
  type RouteSummary,
  SLOWEST,
  summarizeRoutes,
} from "../src/check/report-command.ts";
import {
  batch,
  dependency,
  endpoint,
  fileOf,
  interval,
  operation,
  profile,
  profileEndpoint,
  reaching,
} from "./support/check-batches.ts";
import { REGISTER_URL } from "./support/check-project.ts";

/**
 * `downtrace report`: what each route ran, from one file `DOWNTRACE_INSPECT` wrote, the most queries per request
 * first — the value that needs no account and no tests (proposal 8 of a real integration, which read the file with
 * `jq` by hand).
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function room(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "downtrace-report-"));
  dirs.push(made);
  return made;
}

const LOOKUP = (n: number, totalMs = n) =>
  operation("query", "q-user", 'select * from "users" where "id" = ?', n, totalMs);
const LIST = (n: number, totalMs = n) => operation("query", "q-orders", 'select * from "orders"', n, totalMs);
const STRIPE = (n: number, totalMs = n) => operation("call", "c-stripe", "POST api.stripe.com", n, totalMs);

/**
 * The file of an application that served `GET /orders` twice, each request listing the orders once and looking up
 * twenty users, one by one (the N+1); `GET /users/:id` three times, one lookup each; and `GET /health` once, which
 * ran nothing.
 */
function nPlusOne(): string {
  return fileOf(
    batch("app", {
      intervals: [
        interval(1000, 1000, [
          reaching(endpoint("GET", "/orders", 2, { meanMs: 40 }), dependency("sqlite", [0, 0, 0, 0, 0, 0, 2, 0])),
          reaching(endpoint("GET", "/users/:id", 3, { meanMs: 2 }), dependency("sqlite", [0, 3, 0, 0, 0, 0, 0, 0])),
          endpoint("GET", "/health", 1, { meanMs: 1 }),
        ]),
      ],
      profile: profile(1000, 1000, [
        profileEndpoint("GET", "/orders", [LIST(2, 30), LOOKUP(40, 4)]),
        profileEndpoint("GET", "/users/:id", [LOOKUP(3, 0.3)]),
      ]),
    }),
  );
}

const route = (routes: RouteSummary[], id: string): RouteSummary => {
  const found = routes.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
};

describe("the median of queries per request", () => {
  it("is the bucket the middle request falls in, from the protocol's boundaries", () => {
    expect(medianBucket([0, 0, 0, 3, 0, 0, 0, 0])).toEqual({ from: 3, to: 5 });
    expect(medianBucket([2, 1, 0, 0, 0, 0, 0, 0])).toEqual({ from: 0, to: 0 });
    expect(medianBucket([0, 1, 0, 0, 0, 0, 0, 2])).toEqual({ from: 51, to: null });
    // The lower median, for an even count: two requests, one ran none and one ran fifty-one.
    expect(medianBucket([1, 0, 0, 0, 0, 0, 0, 1])).toEqual({ from: 0, to: 0 });
  });

  it("names every bucket the protocol has, each from the one before it", () => {
    const buckets = CALLS_PER_REQUEST_BOUNDARIES_V0.length + 1;
    const all = Array.from({ length: buckets }, (_, i) =>
      medianBucket(Array.from({ length: buckets }, (_, j) => (i === j ? 1 : 0))),
    );
    expect(all).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 2, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 10 },
      { from: 11, to: 20 },
      { from: 21, to: 50 },
      { from: 51, to: null },
    ]);
  });

  it("is not known with no request, nor when the requests reached several databases", () => {
    expect(medianBucket([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(medianBucket(null)).toBeNull();
  });
});

describe("what the report says of each route", () => {
  const routes = summarizeRoutes(readRun(nPlusOne()));

  it("orders the routes by queries per request, most first", () => {
    expect(routes.map((one) => one.id)).toEqual(["GET /orders", "GET /users/:id", "GET /health"]);
  });

  it("says the requests, the mean of queries per request over the profiled ones, and the median bucket", () => {
    expect(route(routes, "GET /orders")).toMatchObject({
      requests: 2,
      profiledRequests: 2,
      queriesPerRequest: { mean: 21, median: { from: 21, to: 50 }, severalDatabases: false },
      meanRequestMs: 40,
    });
    expect(route(routes, "GET /health").queriesPerRequest).toEqual({
      mean: 0,
      median: { from: 0, to: 0 },
      severalDatabases: false,
    });
  });

  it("names the operations a request ran more than once, and how many times, and not the ones it ran once", () => {
    expect(route(routes, "GET /orders").repeated).toEqual([
      {
        id: "query:q-user",
        kind: "query",
        hash: "q-user",
        label: 'select * from "users" where "id" = ?',
        perRequest: 20,
        executions: 40,
        msPerExecution: 0.1,
      },
    ]);
    expect(route(routes, "GET /users/:id").repeated).toEqual([]);
  });

  it("names the slowest operations by their time per execution", () => {
    expect(route(routes, "GET /orders").slowest.map((one) => [one.id, one.msPerExecution])).toEqual([
      ["query:q-orders", 15],
      ["query:q-user", 0.1],
    ]);
  });

  it(`names ${SLOWEST} slowest at most`, () => {
    const many = Array.from({ length: SLOWEST + 2 }, (_, i) => operation("query", `q${i}`, `SELECT ${i}`, 1, i + 1));
    const [only] = summarizeRoutes(
      readRun(
        fileOf(
          batch("a", {
            intervals: [interval(1000, 1000, [endpoint("GET", "/p", 1, { requestsWithCalls: 1 })])],
            profile: profile(1000, 1000, [profileEndpoint("GET", "/p", many)]),
          }),
        ),
      ),
    );
    expect(only?.slowest.map((one) => one.id)).toEqual(["query:q4", "query:q3", "query:q2"]);
  });

  it("repeats an outgoing call or a Redis command like a query, and counts only queries as queries", () => {
    const [only] = summarizeRoutes(
      readRun(
        fileOf(
          batch("a", {
            intervals: [interval(1000, 1000, [endpoint("POST", "/checkout", 2, { requestsWithCalls: 2 })])],
            profile: profile(1000, 1000, [profileEndpoint("POST", "/checkout", [STRIPE(24), LIST(2)])]),
          }),
        ),
      ),
    );
    expect(only?.queriesPerRequest.mean).toBe(1);
    expect(only?.repeated.map((one) => [one.id, one.perRequest])).toEqual([["call:c-stripe", 12]]);
  });

  it("does not know the queries of a route no profile covered, and puts it last; the median comes from the intervals", () => {
    const run = readRun(
      fileOf(
        batch("a", {
          intervals: [
            interval(1000, 1000, [
              reaching(
                endpoint("GET", "/lost", 4, { requestsWithCalls: 4 }),
                dependency("postgres", [0, 0, 4, 0, 0, 0, 0, 0]),
              ),
              endpoint("GET", "/health", 1),
            ]),
          ],
        }),
      ),
    );
    const [first, last] = summarizeRoutes(run);
    expect(first?.id).toBe("GET /health");
    expect(last).toMatchObject({
      id: "GET /lost",
      profiledRequests: 0,
      queriesPerRequest: { mean: null, median: { from: 2, to: 2 } },
      repeated: [],
    });
  });

  it("does not make up a median when the requests reached two databases", () => {
    const [only] = summarizeRoutes(
      readRun(
        fileOf(
          batch("a", {
            intervals: [
              interval(1000, 1000, [
                reaching(
                  endpoint("GET", "/p", 2, { requestsWithCalls: 2 }),
                  dependency("postgres", [0, 2, 0, 0, 0, 0, 0, 0], "primary:5432"),
                  dependency("mongodb", [0, 2, 0, 0, 0, 0, 0, 0], "docs:27017"),
                ),
              ]),
            ],
            profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [LIST(2), LOOKUP(2)])]),
          }),
        ),
      ),
    );
    expect(only?.queriesPerRequest).toEqual({ mean: 2, median: null, severalDatabases: true });
  });
});

async function report(text: string, args: string[] = []) {
  const dir = await room();
  await writeFile(join(dir, "run.jsonl"), text);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv: ["report", ...args, "run.jsonl"],
    env: { PATH: process.env.PATH },
    cwd: dir,
    tmpRoot: tmpdir(),
    registerUrl: REGISTER_URL,
    version: "9.9.9",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: undefined,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("downtrace report", () => {
  it("says each route in words, the most queries per request first, and ends with 0", async () => {
    const { code, stdout, stderr } = await report(nPlusOne());
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("downtrace report: run.jsonl\n  6 requests on 3 routes, 1 process wrote 1 batch\n");
    expect(stdout).toContain("  GET /orders   2 requests  ·  21 queries per request on average, median 21 to 50");
    expect(stdout).toContain('    repeated   select * from "users" where "id" = ?  [query q-user]  20 per request');
    expect(stdout).toContain(
      '    slowest    select * from "orders"  [query q-orders]  15 ms per execution, 1 per request',
    );
    expect(stdout).toContain("  GET /users/:id   3 requests  ·  1 query per request on average, median 1");
    expect(stdout.indexOf("GET /orders")).toBeLessThan(stdout.indexOf("GET /users/:id"));
    expect(stdout.indexOf("GET /users/:id")).toBeLessThan(stdout.indexOf("GET /health"));
  });

  it("says the same as JSON with --json, for a coding agent", async () => {
    const { code, stdout } = await report(nPlusOne(), ["--json"]);
    expect(code).toBe(0);
    const said = JSON.parse(stdout) as RouteReport;
    expect(said).toMatchObject({
      schema: ROUTE_REPORT_SCHEMA,
      status: "reported",
      failure: null,
      file: { file: "run.jsonl", processes: 1, batches: 1, requests: 6, routes: 3, malformed: 0, unreadLines: [] },
    });
    expect(said.routes).toEqual(summarizeRoutes(readRun(nPlusOne())));
  });

  it("names the lines it left out, and says how many could not be read", async () => {
    const { code, stdout } = await report(`${nPlusOne()}\n{"protocol":"0.13.0","inst`);
    expect(code).toBe(0);
    expect(stdout).toContain("6 requests on 3 routes, 1 process wrote 1 batch  ·  left out: line 2");
    expect(stdout).toContain("1 line of run.jsonl could not be read and was left out.");
  });

  it("says when requests made calls that no profile window covers yet, and why that may be", async () => {
    const { stdout } = await report(
      fileOf(batch("a", { intervals: [interval(1000, 1000, [endpoint("GET", "/p", 4, { requestsWithCalls: 4 })])] })),
    );
    expect(stdout).toContain("queries per request not known: no profile covered its requests");
    expect(stdout).toContain("4 requests made calls that no profile covers");
    expect(stdout).toContain("stop the application, then read the file");
  });

  it("says a file that is not one DOWNTRACE_INSPECT wrote, with its line, and ends with 2 and no stack", async () => {
    const { code, stdout, stderr } = await report("Server listening on port 3000\n");
    expect(code).toBe(2);
    expect(stderr).toBe("");
    expect(stdout).toContain("downtrace report: no report could be made");
    expect(stdout).toContain("line 1 is the first that fails: it is not JSON");
    expect(stdout).not.toMatch(/\n\s+at /);
  });

  it("says a protocol it cannot read as JSON, with the line, and ends with 2", async () => {
    const later = { ...(JSON.parse(nPlusOne()) as Record<string, unknown>), protocol: "1.0.0" };
    const { code, stdout } = await report(`${nPlusOne()}\n${JSON.stringify(later)}`, ["--json"]);
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      schema: ROUTE_REPORT_SCHEMA,
      status: "failed",
      file: null,
      routes: [],
      failure: { code: "unreadable-protocol", line: 2 },
    });
  });
});
