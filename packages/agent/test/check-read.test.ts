import { AGGREGATES_SCHEMA_V0, DEPENDENCY_KINDS_V0, type Endpoint } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { DATABASE_KINDS, identify, RunReader, readDeclared, readRun, readSites } from "../src/check/read.ts";
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

/**
 * What a run left behind, read back. The file is written by every process the run started, so a route is in many
 * lines and no line says anything about the others (DT-79): the tests below are about merging them, and about what
 * is never counted twice or invented.
 */

const QUERY = (n: number) => operation("query", "q1", "SELECT id FROM products WHERE id = ?", n);

describe("the batches these tests build", () => {
  // The builders are only worth anything if what they make is what the instrumentation writes.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const keyword of [
    "x-latency-boundaries-ms",
    "x-calls-per-request-boundaries",
    "x-ingest-path",
    "x-since",
    "x-error",
    "x-evidence-path",
  ]) {
    ajv.addKeyword(keyword);
  }
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

  it("are valid against the schema of the protocol", () => {
    const one = batch("a", {
      intervals: [interval(1000, 1000, [endpoint("GET", "/p", 4, { requestsWithCalls: 4 })])],
      profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(4)])]),
      observers: { pg: "on", http: "on" },
    });
    expect(validate(one), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("reading the file of a run", () => {
  it("merges a route across the processes that wrote it", () => {
    const text = fileOf(
      batch("a", {
        intervals: [interval(1000, 1000, [endpoint("GET", "/p", 4, { requestsWithCalls: 4 })])],
        profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(4)])]),
      }),
      batch("b", {
        intervals: [interval(1000, 1000, [endpoint("GET", "/p", 6, { requestsWithCalls: 6 })])],
        profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(12)])]),
      }),
    );
    const run = readRun(text);
    const route = run.routes.get("GET /p");
    expect(run.processes).toBe(2);
    expect(route?.requests).toBe(10);
    expect(route?.profiledRequests).toBe(10);
    expect(route?.operations.get("query:q1")?.executions).toBe(16);
  });

  it("does not count a helper that served nothing as a route, nor miss that it wrote", () => {
    const run = readRun(fileOf(batch("helper", {})));
    expect(run.processes).toBe(1);
    expect(run.routes.size).toBe(0);
    expect(run.requests).toBe(0);
  });

  it("counts an interval and a window written twice once: the same process, the same instant", () => {
    const written = batch("a", {
      intervals: [interval(1000, 1000, [endpoint("GET", "/p", 4, { requestsWithCalls: 4 })])],
      profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(4)])]),
    });
    const run = readRun(fileOf(written, written));
    const route = run.routes.get("GET /p");
    expect(route?.requests).toBe(4);
    expect(route?.operations.get("query:q1")?.executions).toBe(4);
    expect(run.profileWindows).toBe(1);
  });

  it("does not take two processes at the same instant for one", () => {
    const at = (id: string) =>
      batch(id, {
        intervals: [interval(1000, 1000, [endpoint("GET", "/p", 1, { requestsWithCalls: 1 })])],
        profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(1)])]),
      });
    expect(readRun(fileOf(at("a"), at("b"))).routes.get("GET /p")?.requests).toBe(2);
  });

  it("says what it could not read and reads the rest: a line cut in the middle is not a crash", () => {
    const good = batch("a", { intervals: [interval(1000, 1000, [endpoint("GET", "/p", 3)])] });
    const text = [
      JSON.stringify(good),
      '{"protocol":"0.9.0","instance":{"id":"b"},"intervals":[{"start":1',
      '"just a string"',
      JSON.stringify({ instance: { id: "c" }, intervals: [{ start: "x" }, 7], profile: { start: 1 } }),
    ].join("\n");
    const run = readRun(text);
    expect(run.routes.get("GET /p")?.requests).toBe(3);
    // The cut line, the string, the interval with a start that is not a number, the number, the profile with no
    // duration: five things that were there and could not be read.
    expect(run.malformed).toBe(5);
  });

  it("does not read the errors beside the operations as a composition, and does not call them malformed", () => {
    const run = readRun(
      fileOf(
        batch("a", {
          intervals: [interval(1000, 1000, [endpoint("GET", "/p", 2, { requestsWithCalls: 2 })])],
          profile: profile(1000, 1000, [
            profileEndpoint("GET", "/p", [QUERY(2), operation("error", "e1", "Error: boom", 2)]),
          ]),
        }),
      ),
    );
    expect([...(run.routes.get("GET /p")?.operations.keys() ?? [])]).toEqual(["query:q1"]);
    expect(run.malformed).toBe(0);
  });

  it("says what the instrumentation reported it observed, and when two processes disagree", () => {
    const run = readRun(
      fileOf(batch("a", { observers: { pg: "on", http: "on" } }), batch("b", { observers: { pg: "unavailable" } })),
    );
    expect(run.observers).toEqual({ pg: "on/unavailable", http: "on" });
  });

  // The stranger campaign (Outline, under yarn and Vitest's threads): the runner's own process loads the
  // instrumentation and no application, so its driver is unresolvable — and every route carried its queries all the
  // same. What a process that answered nothing could not observe is nothing the run lost.
  it("says what the processes that answered requests observed, and not what one that answered none could not", () => {
    const answered = [interval(1000, 1000, [endpoint("GET", "/p", 4, { requestsWithCalls: 4 })])];
    const runner = batch("runner", { observers: { pg: "unavailable", http: "on" } });
    const app = batch("app", { intervals: answered, observers: { pg: "on", http: "on" } });
    expect(readRun(fileOf(runner, app)).observers).toEqual({ pg: "on", http: "on" });
    expect(readRun(fileOf(app, runner)).observers, "whichever wrote first").toEqual({ pg: "on", http: "on" });
  });

  it("still says when two processes that answered requests disagree", () => {
    const answered = [interval(1000, 1000, [endpoint("GET", "/p", 4, { requestsWithCalls: 4 })])];
    const one = batch("one", { intervals: answered, observers: { pg: "on" } });
    const other = batch("other", { intervals: answered, observers: { pg: "unavailable" } });
    expect(readRun(fileOf(one, other)).observers).toEqual({ pg: "on/unavailable" });
  });
});

describe("how many queries each request ran, from the intervals", () => {
  const read = (...endpoints: Parameters<typeof interval>[2]) =>
    readRun(fileOf(batch("a", { intervals: [interval(1000, 1000, endpoints)] }))).routes.get("GET /p");

  it("takes a database's buckets, and counts the requests that did not reach it as running no query", () => {
    // Six requests: three ran 3 to 5 queries, one ran 1, and two never reached the database.
    const route = read(reaching(endpoint("GET", "/p", 6), dependency("postgres", [0, 1, 0, 3, 0, 0, 0, 0])));
    expect(route?.queriesPerRequest).toEqual([2, 1, 0, 3, 0, 0, 0, 0]);
  });

  it("counts every request in the first bucket when none reached a database, or only an outgoing host did", () => {
    expect(read(endpoint("GET", "/p", 4))?.queriesPerRequest).toEqual([4, 0, 0, 0, 0, 0, 0, 0]);
    const called = reaching(endpoint("GET", "/p", 4), dependency("http", [0, 0, 0, 0, 0, 4, 0, 0], "api.example.com"));
    expect(read(called)?.queriesPerRequest).toEqual([4, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("adds the buckets of every interval and every process", () => {
    const route = readRun(
      fileOf(
        batch("a", {
          intervals: [
            interval(1000, 1000, [reaching(endpoint("GET", "/p", 2), dependency("sqlite", [0, 2, 0, 0, 0, 0, 0, 0]))]),
          ],
        }),
        batch("b", {
          intervals: [
            interval(1000, 1000, [reaching(endpoint("GET", "/p", 3), dependency("sqlite", [0, 0, 0, 0, 0, 0, 3, 0]))]),
          ],
        }),
      ),
    ).routes.get("GET /p");
    expect(route?.queriesPerRequest).toEqual([0, 2, 0, 0, 0, 0, 3, 0]);
  });

  it("does not know them when the requests of an interval reached two databases, whose queries cannot be added", () => {
    const two = reaching(
      endpoint("GET", "/p", 2),
      dependency("postgres", [0, 2, 0, 0, 0, 0, 0, 0], "db-a:5432"),
      dependency("postgres", [0, 2, 0, 0, 0, 0, 0, 0], "db-b:5432"),
    );
    expect(read(two)?.queriesPerRequest).toBeNull();
  });

  it("reads the field Postgres's queries travelled in before protocol 0.4.0", () => {
    const legacy: Endpoint = {
      ...endpoint("GET", "/p", 3),
      postgres: { queriesPerRequest: [0, 0, 3, 0, 0, 0, 0, 0], totalMs: 1, max: 1 },
    };
    expect(read(legacy)?.queriesPerRequest).toEqual([0, 0, 3, 0, 0, 0, 0, 0]);
  });

  it("counts buckets it cannot read, and does not guess a median from them", () => {
    const reader = new RunReader();
    const broken = { ...dependency("mysql", [0, 0, 0, 0, 0, 0, 0, 0]), callsPerRequest: [1, 2] as never };
    const problems = reader.addBatch(
      batch("a", { intervals: [interval(1000, 1000, [reaching(endpoint("GET", "/p", 3), broken)])] }),
    );
    expect(problems).toBe(1);
    const run = reader.finish();
    expect(run.malformed).toBe(1);
    expect(run.routes.get("GET /p")?.queriesPerRequest).toBeNull();
  });

  it("knows a database by every kind of the protocol that is not an outgoing call or a Redis command", () => {
    expect([...DATABASE_KINDS].sort()).toEqual(
      DEPENDENCY_KINDS_V0.filter((kind) => kind !== "http" && kind !== "redis").sort(),
    );
  });
});

describe("reading a line already parsed", () => {
  it("says how much of it could not be read: nothing, the line, or entries of it", () => {
    const reader = new RunReader();
    expect(reader.addBatch(batch("a", { intervals: [interval(1000, 1000, [endpoint("GET", "/p", 1)])] }))).toBe(0);
    expect(reader.addBatch({ protocol: "0.13.0" })).toBe(1);
    expect(reader.addBatch(batch("a", { intervals: [{ start: "soon" } as never, { start: 2000 } as never] }))).toBe(2);
    expect(reader.finish()).toMatchObject({ batches: 2, malformed: 3, requests: 1 });
  });
});

describe("which requests a profile can speak for", () => {
  // The instrumentation writes a profile once a window closes, and a runner that ends the process abruptly cuts
  // the window in hand. The requests of an interval the file has no window for made calls nobody wrote down: if
  // they were counted, the executions that were written would be divided by requests that never had any.
  const intervals = [
    interval(1000, 1000, [endpoint("GET", "/p", 5, { requestsWithCalls: 5 })]),
    interval(2000, 1000, [endpoint("GET", "/p", 5, { requestsWithCalls: 5 })]),
  ];

  it("leaves out of the division the requests that made calls and that no window covers", () => {
    const run = readRun(
      fileOf(batch("a", { intervals, profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(5)])]) })),
    );
    const route = run.routes.get("GET /p");
    expect(route?.requests).toBe(10);
    expect(route?.profiledRequests).toBe(5);
    expect(route?.unprofiledRequests).toBe(5);
  });

  it("knows what a request that made no calls ran: nothing, and no window was needed to say so", () => {
    const run = readRun(fileOf(batch("a", { intervals: [interval(1000, 1000, [endpoint("GET", "/health", 5)])] })));
    const route = run.routes.get("GET /health");
    expect(route?.profiledRequests).toBe(5);
    expect(route?.unprofiledRequests).toBe(0);
  });

  it("takes the window of the process that wrote the interval, and no other process's", () => {
    const run = readRun(
      fileOf(
        batch("a", { intervals: [interval(1000, 1000, [endpoint("GET", "/p", 5, { requestsWithCalls: 5 })])] }),
        batch("b", { profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(5)])]) }),
      ),
    );
    expect(run.routes.get("GET /p")?.unprofiledRequests).toBe(5);
  });

  it("covers an interval a few milliseconds off its window, which is how they close", () => {
    const run = readRun(
      fileOf(
        batch("a", {
          intervals: [interval(1003, 1000, [endpoint("GET", "/p", 5, { requestsWithCalls: 5 })])],
          profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [QUERY(5)])]),
        }),
      ),
    );
    expect(run.routes.get("GET /p")?.unprofiledRequests).toBe(0);
  });
});

describe("what makes two operations the same one", () => {
  it("is the kind and the fingerprint", () => {
    expect(identify("query", "abc", "SELECT 1")).toEqual({ id: "query:abc", hash: "abc", label: "SELECT 1" });
  });

  // A server a test starts on port 0 has another port on every run, and the port is in the text the fingerprint is
  // the hash of: left alone, the same call would be an operation that appeared beside one that vanished.
  it.each([
    ["call", "POST 127.0.0.1:41233", "POST 127.0.0.1"],
    ["call", "GET localhost:5000", "GET localhost"],
    ["call", "get LOCALHOST", "GET localhost"],
    ["command", "HGETALL 127.0.0.1:55012", "HGETALL 127.0.0.1"],
    ["command", "GET [::1]:6380", "GET [::1]"],
  ] as const)("folds the port of this machine out of a %s: %s", (kind, text, place) => {
    expect(identify(kind, "any-hash", text)).toMatchObject({ id: `${kind}:${place}`, hash: undefined });
  });

  it("does not fold two runs' ports into each other for a host that is not this machine's", () => {
    expect(identify("call", "h1", "POST api.stripe.com:8443").id).toBe("call:h1");
    expect(identify("call", "h2", "POST 10.0.0.5:8443").id).toBe("call:h2");
  });

  it("does not fold a query, whatever it looks like", () => {
    expect(identify("query", "h3", "SELECT 'localhost:5432'").id).toBe("query:h3");
  });

  it("keeps the fingerprint when no text travelled: nothing to fold", () => {
    expect(identify("call", "h4", undefined)).toEqual({ id: "call:h4", hash: "h4", label: undefined });
  });

  it("makes one operation of the same call to two ports, summed", () => {
    const run = readRun(
      fileOf(
        batch("a", {
          intervals: [interval(1000, 1000, [endpoint("POST", "/c", 2, { requestsWithCalls: 2 })])],
          profile: profile(1000, 1000, [
            profileEndpoint("POST", "/c", [
              operation("call", "h-1111", "POST 127.0.0.1:1111", 1),
              operation("call", "h-2222", "POST 127.0.0.1:2222", 1),
            ]),
          ]),
        }),
      ),
    );
    const operations = run.routes.get("POST /c")?.operations;
    expect(operations?.size).toBe(1);
    expect(operations?.get("call:POST 127.0.0.1")?.executions).toBe(2);
  });
});

describe("reading the routes the applications of a run declared (ESC-18)", () => {
  it("merges every line of every process into one list, each route once", () => {
    const text = [
      JSON.stringify({ routes: ["GET /health", "POST /orders"] }),
      JSON.stringify({ routes: ["GET /health", "GET /late"] }),
    ].join("\n");
    expect(readDeclared(text)).toEqual({ routes: ["GET /health", "GET /late", "POST /orders"], malformed: 0 });
  });

  it("counts what it cannot read, a line cut by a process that ended among them, and invents nothing", () => {
    const text = [
      JSON.stringify({ routes: ["GET /health"] }),
      '{"routes":["GET /he',
      JSON.stringify({ routes: "GET /x" }),
      JSON.stringify({ routes: ["GET /ok", 42, "not a route", "BREW /coffee"] }),
      "",
    ].join("\n");
    expect(readDeclared(text)).toEqual({ routes: ["GET /health", "GET /ok"], malformed: 5 });
  });
});

describe("reading where the change run ran its operations (RF-526)", () => {
  // covers: RF-526
  const site = (route: string, at: unknown, more: Record<string, unknown> = {}) => ({
    route,
    kind: "query",
    hash: "q1",
    at,
    ...more,
  });

  it("merges every process's lines by route and operation, each place once, in the order found", () => {
    const text = [
      JSON.stringify({ sites: [site("GET /orders/:id", "src/orders.ts:9"), site("GET /health", "src/health.ts:3")] }),
      JSON.stringify({
        sites: [site("GET /orders/:id", "src/orders.ts:9"), site("GET /orders/:id", "src/lines.ts:4")],
      }),
    ].join("\n");
    const read = readSites(text);
    expect(read.malformed).toBe(0);
    expect(read.sites.get("GET /orders/:id")?.get("query:q1")).toEqual(["src/orders.ts:9", "src/lines.ts:4"]);
    expect(read.sites.get("GET /health")?.get("query:q1")).toEqual(["src/health.ts:3"]);
  });

  it("names an operation as the comparison does, a call to this machine by its place and not its port", () => {
    const call = { kind: "call", hash: "c9", text: "GET 127.0.0.1:41234" };
    const read = readSites(JSON.stringify({ sites: [site("POST /checkout", "src/pay.ts:12", call)] }));
    expect(read.sites.get("POST /checkout")?.get(identify("call", "c9", "GET 127.0.0.1:41234").id)).toEqual([
      "src/pay.ts:12",
    ]);
  });

  it("takes no place that is absolute, above the project or in a node_modules, whatever wrote the file", () => {
    const text = [
      JSON.stringify({
        sites: [
          site("GET /a", "/home/someone/app/src/a.ts:1"),
          site("GET /a", "../outside/a.ts:2"),
          site("GET /a", "src/../../a.ts:3"),
          site("GET /a", "node_modules/pg/lib/client.js:4"),
          site("GET /a", "src/a.ts"),
          site("GET /a", 42),
          site("GET /a", "src/a.ts:5"),
        ],
      }),
      '{"sites":[{"route":"GET /a","ki',
      JSON.stringify({ sites: "src/a.ts:6" }),
      JSON.stringify({ sites: [{ route: "GET /a", kind: "error", hash: "e", at: "src/a.ts:7" }] }),
    ].join("\n");
    const read = readSites(text);
    expect(read.sites.get("GET /a")?.get("query:q1")).toEqual(["src/a.ts:5"]);
    expect(read.malformed).toBe(9);
  });
});
