import { AGGREGATES_SCHEMA_V0 } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { identify, readRun } from "../src/check/read.ts";
import { batch, endpoint, fileOf, interval, operation, profile, profileEndpoint } from "./support/check-batches.ts";

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
