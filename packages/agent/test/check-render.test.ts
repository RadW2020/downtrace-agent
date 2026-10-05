import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/check/compare.ts";
import { readRun } from "../src/check/read.ts";
import { fmt, renderJson, renderText } from "../src/check/render.ts";
import {
  type CheckReport,
  compared,
  DURATIONS_NOTE,
  exitCodeOf,
  FAILURE_CODES,
  failed,
  REPORT_SCHEMA,
  type SideReport,
} from "../src/check/report.ts";
import { batch, endpoint, fileOf, interval, operation, profile, profileEndpoint } from "./support/check-batches.ts";

/**
 * One report, read three ways: as text by a person, as JSON by a coding agent, as a status by CI. They are the same
 * object, so what the person is told and what the agent is told cannot disagree (invariant 13).
 */
// covers: LOC-01, ESC-17, ESC-18

const side = (ref: string, over: Partial<SideReport> = {}): SideReport => ({
  ref,
  commit: "9fb6e99ca1f0",
  command: "npm test",
  exitCode: 0,
  durationMs: 1400,
  processes: 2,
  batches: 4,
  requests: 20,
  routes: 3,
  profileWindows: 2,
  malformed: 0,
  observers: {},
  ...over,
});

function reportOf(): CheckReport {
  const q = (hash: string, count: number, ms: number) =>
    operation("query", hash, `SELECT ${hash} FROM t WHERE id = ?`, count, ms);
  const provider = operation("call", "c1", "POST provider.test", 6);
  const cache = operation("command", "r1", "GET cache:6379", 9);
  const run = (checkout: ReturnType<typeof operation>[], meanMs: number) =>
    readRun(
      fileOf(
        batch("p", {
          intervals: [
            interval(1000, 1000, [
              endpoint("POST", "/checkout", 3, { requestsWithCalls: 3, meanMs }),
              endpoint("GET", "/products", 4, { requestsWithCalls: 4, meanMs }),
              endpoint("GET", "/health", 2, { meanMs }),
            ]),
          ],
          profile: profile(1000, 1000, [
            profileEndpoint("POST", "/checkout", checkout),
            profileEndpoint("GET", "/products", [q("p", 4, 8)]),
          ]),
        }),
      ),
    );
  const routes = compareRuns(
    run([q("a", 3, 6), provider, cache], 12),
    run([q("a", 3, 6), q("n1", 36, 40), provider, cache], 31),
    ["GET /orders"],
  );
  return compared({ base: side("main"), change: side("working tree"), routes, notes: ["a note"] });
}

describe("the report as text", () => {
  const text = renderText(reportOf());

  it("has the three columns, in the order the product says, each with how many it holds", () => {
    const at = (title: string) => text.indexOf(title);
    expect(at("Worse (1)")).toBeGreaterThan(-1);
    expect(at("Unchanged (1)")).toBeGreaterThan(at("Worse (1)"));
    expect(at("Not evaluated (2)")).toBeGreaterThan(at("Unchanged (1)"));
  });

  it("names the operation that appeared by its fingerprint and says how many times a request ran it", () => {
    expect(text).toContain("POST /checkout");
    expect(text).toMatch(/appeared\s+SELECT n1 FROM t WHERE id = \?\s+\[query n1\]\s+0 -> 12 per request/);
  });

  it("says what did not get worse beside what did", () => {
    expect(text).toContain("did not get worse: outgoing calls 2 per request · Redis commands 3 per request");
  });

  it("puts a route that was not evaluated under Not evaluated, with its reason, and never under Unchanged", () => {
    const [worseAndUnchanged, notEvaluated] = text.split("Not evaluated (2)");
    expect(notEvaluated).toContain("GET /orders");
    expect(notEvaluated).toContain("no request reached it in either run");
    expect(notEvaluated).toContain("GET /health");
    expect(worseAndUnchanged).not.toContain("GET /orders");
    expect(worseAndUnchanged).not.toContain("GET /health");
  });

  it("shows the durations, says they are not judged, and uses no word of judgement for them", () => {
    expect(text).toContain("request duration, shown and not judged: 12 ms -> 31 ms");
    expect(text).toContain(DURATIONS_NOTE);
    expect(text).not.toMatch(/slower|faster|regress(ed|ion) in latency/i);
  });

  it("says how many routes it could and could not evaluate: a statement that names what it left out", () => {
    expect(text).toContain("2 of 4 routes evaluated: 1 worse, 1 unchanged.");
  });

  it("names the two runs and what each left", () => {
    expect(text).toContain("base   ");
    expect(text).toContain("20 requests on 3 routes, 2 processes wrote");
    expect(text).toContain("against main (9fb6e99ca)");
  });
});

describe("the report as JSON", () => {
  const json = JSON.parse(renderJson(reportOf())) as ReturnType<typeof reportOf>;

  it("carries its schema, so a reader knows what it is reading", () => {
    expect(json.schema).toBe(REPORT_SCHEMA);
    expect(json.status).toBe("compared");
  });

  it("gives each route a stable identifier, the requests each side saw, and a verdict", () => {
    const checkout = json.routes.find((route) => route.id === "POST /checkout");
    expect(checkout).toMatchObject({
      method: "POST",
      route: "/checkout",
      verdict: "worse",
      requests: { base: 3, change: 3 },
      profiledRequests: { base: 3, change: 3 },
    });
  });

  it("gives each operation the hash of its fingerprint, its kind and how many times a request ran it", () => {
    const checkout = json.routes.find((route) => route.id === "POST /checkout");
    expect(checkout?.operations[0]).toMatchObject({
      id: "query:n1",
      hash: "n1",
      kind: "query",
      change: "appeared",
      worse: true,
      perRequest: { base: 0, change: 12 },
    });
  });

  it("says which routes were not evaluated and why, by a code an agent can branch on", () => {
    const skipped = json.routes.filter((route) => route.verdict === "not-evaluated");
    expect(skipped.map((route) => [route.id, route.reasons.map((reason) => reason.code)])).toEqual([
      ["GET /health", ["nothing-observed"]],
      ["GET /orders", ["not-called"]],
    ]);
  });

  it("counts them", () => {
    expect(json.summary).toEqual({ worse: 1, unchanged: 1, notEvaluated: 2 });
  });
});

describe("the exit status", () => {
  it("is 1 when a route got worse, 0 when none did, and 2 when there was nothing to compare", () => {
    expect(exitCodeOf(reportOf())).toBe(1);
    expect(exitCodeOf(compared({ base: side("a"), change: side("b"), routes: [], notes: [] }))).toBe(0);
    for (const code of FAILURE_CODES) {
      const report = failed({ failure: { code, side: null, message: "m", advice: null, outputTail: null } });
      expect(exitCodeOf(report), code).toBe(2);
    }
  });
});

describe("a comparison that could not be made", () => {
  const report = failed({
    failure: {
      code: "no-profile",
      side: "base",
      message: "the run left no profile",
      advice: "This happens with Jest --forceExit: drop --forceExit.",
      outputTail: "line one\nline two",
    },
    base: side("main", { requests: 0, routes: 0 }),
  });

  it("says so in the words the product uses, with the cause and the output it came from", () => {
    const text = renderText(report);
    expect(text).toContain("no comparison could be made");
    expect(text).toContain("base: the run left no profile");
    expect(text).toContain("This happens with Jest --forceExit: drop --forceExit.");
    expect(text).toContain("Last output of the base run:");
    expect(text).toContain("  line two");
  });

  it("never says anything is unchanged", () => {
    expect(renderText(report)).not.toMatch(/unchanged/i);
    expect(JSON.parse(renderJson(report))).toMatchObject({ status: "failed", summary: null, routes: [] });
  });
});

describe("numbers as a person reads them", () => {
  it.each([
    [12, "12"],
    [0.3333333, "0.33"],
    [1.5, "1.5"],
    [0, "0"],
  ])("%s is %s", (value, text) => {
    expect(fmt(value)).toBe(text);
  });
});
