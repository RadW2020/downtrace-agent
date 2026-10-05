import { describe, expect, it } from "vitest";
import {
  BUCKET_ROUTES,
  compareRuns,
  MIN_RISE_PER_REQUEST,
  MIN_RISE_RATIO,
  NOT_EVALUATED_REASONS,
  type NotEvaluatedReason,
  type RouteResult,
  summarize,
} from "../src/check/compare.ts";
import { type RunTally, readRun } from "../src/check/read.ts";
import { batch, endpoint, fileOf, interval, operation, profile, profileEndpoint } from "./support/check-batches.ts";

/**
 * The comparison before the deploy judges composition and says what it did not exercise (LOC-01, ESC-17, ESC-18).
 * Each case builds the two runs as the instrumentation would have written them and reads them back, so the input
 * of the comparison is always what the reader makes of a file.
 */
// covers: LOC-01, ESC-17, ESC-18

interface Spec {
  method?: "GET" | "POST";
  route: string;
  requests: number;
  operations?: ReturnType<typeof operation>[];
  /** Mean duration of a request, in ms. */
  meanMs?: number;
  /** False: the interval is there and the profile window is not (a run cut short). */
  profiled?: boolean;
}

function runOf(...specs: Spec[]): RunTally {
  const withProfile = specs.filter((spec) => spec.profiled !== false);
  return readRun(
    fileOf(
      batch("p", {
        intervals: [
          interval(
            1000,
            1000,
            specs.map((spec) =>
              endpoint(spec.method ?? "GET", spec.route, spec.requests, {
                meanMs: spec.meanMs ?? 5,
                requestsWithCalls: (spec.operations?.length ?? 0) > 0 ? spec.requests : 0,
              }),
            ),
          ),
        ],
        ...(withProfile.length === 0
          ? {}
          : {
              profile: profile(
                1000,
                1000,
                withProfile.map((spec) => profileEndpoint(spec.method ?? "GET", spec.route, spec.operations ?? [])),
              ),
            }),
      }),
    ),
  );
}

const Q = (hash: string, count: number, totalMs = count) =>
  operation("query", hash, `SELECT ${hash} FROM t WHERE id = ?`, count, totalMs);
const CALL = (host: string, count: number) => operation("call", `c-${host}`, `POST ${host}`, count);
const CMD = (count: number) => operation("command", "r1", "GET cache:6379", count);

function only(base: RunTally, change: RunTally, id: string): RouteResult {
  const found = compareRuns(base, change).find((route) => route.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
}

describe("what makes a route worse", () => {
  it("is an operation that appeared, with its fingerprint and how many times a request ran it (ESC-17)", () => {
    const base = runOf({
      method: "POST",
      route: "/checkout",
      requests: 3,
      operations: [Q("a", 3), CALL("api", 6), CMD(9)],
    });
    const change = runOf({
      method: "POST",
      route: "/checkout",
      requests: 3,
      operations: [Q("a", 3), Q("n1", 36), CALL("api", 6), CMD(9)],
    });
    const route = only(base, change, "POST /checkout");
    expect(route.verdict).toBe("worse");
    const appeared = route.operations.find((operation) => operation.hash === "n1");
    expect(appeared).toMatchObject({
      id: "query:n1",
      kind: "query",
      change: "appeared",
      worse: true,
      perRequest: { base: 0, change: 12 },
      executions: { base: 0, change: 36 },
    });
    // The dependencies that did not change are said as unchanged: the provider and Redis.
    const kinds = Object.fromEntries(route.dependencies.map((dependency) => [dependency.kind, dependency]));
    expect(kinds.query?.worse).toBe(true);
    expect(kinds.call).toMatchObject({ worse: false, perRequest: { base: 2, change: 2 } });
    expect(kinds.command).toMatchObject({ worse: false, perRequest: { base: 3, change: 3 } });
  });

  it("is an operation that runs several times more per request than it did, and says how many", () => {
    const base = runOf({ route: "/p", requests: 2, operations: [Q("a", 2)] });
    const change = runOf({ route: "/p", requests: 2, operations: [Q("a", 24)] });
    const route = only(base, change, "GET /p");
    expect(route.verdict).toBe("worse");
    expect(route.operations[0]).toMatchObject({ change: "multiplied", perRequest: { base: 1, change: 12 } });
  });

  it("is judged per request, so that more traffic through the same code is not a regression", () => {
    const base = runOf({ route: "/p", requests: 2, operations: [Q("a", 2)] });
    const change = runOf({ route: "/p", requests: 40, operations: [Q("a", 40)] });
    expect(only(base, change, "GET /p").verdict).toBe("unchanged");
  });

  it("is a different call to a host this machine reached on another port: not a different operation", () => {
    const at = (port: number) =>
      runOf({
        route: "/p",
        requests: 2,
        operations: [operation("call", `h${port}`, `POST 127.0.0.1:${port}`, 2)],
      });
    expect(only(at(41001), at(52002), "GET /p")).toMatchObject({ verdict: "unchanged" });
  });
});

describe("what is not worse", () => {
  it("is the same composition", () => {
    const same = runOf({ route: "/p", requests: 3, operations: [Q("a", 3), CALL("api", 3)] });
    const route = only(same, same, "GET /p");
    expect(route.verdict).toBe("unchanged");
    expect(route.operations.every((operation) => operation.change === "unchanged")).toBe(true);
  });

  // The thresholds are two, and both are needed: a ratio alone fires on a fifth of an execution becoming a
  // quarter, a floor alone on a third more of something that already ran forty times.
  it.each([
    ["a rise under the ratio", 40, 48, "unchanged"],
    ["a rise under the floor", 1, 1.4, "unchanged"],
    ["a rise that clears both", 1, 1.5, "multiplied"],
    ["a rise just on the ratio and the floor", 2, 2.5, "multiplied"],
    ["a fall that clears both", 4, 2, "reduced"],
    ["a fall under the floor", 1, 0.7, "unchanged"],
  ] as const)("is %s: %s -> %s executions per request is %s", (_what, was, is, expected) => {
    const base = runOf({ route: "/p", requests: 10, operations: [Q("a", was * 10)] });
    const change = runOf({ route: "/p", requests: 10, operations: [Q("a", is * 10)] });
    expect(only(base, change, "GET /p").operations[0]?.change).toBe(expected);
  });

  it("has the thresholds the README states", () => {
    expect([MIN_RISE_RATIO, MIN_RISE_PER_REQUEST]).toEqual([1.25, 0.5]);
  });

  it("is an operation that is gone: less work is not worse, and it is said", () => {
    const base = runOf({ route: "/p", requests: 2, operations: [Q("a", 2), Q("b", 2)] });
    const change = runOf({ route: "/p", requests: 2, operations: [Q("a", 2)] });
    const route = only(base, change, "GET /p");
    expect(route.verdict).toBe("unchanged");
    expect(route.operations.find((operation) => operation.id === "query:b")?.change).toBe("disappeared");
  });
});

describe("durations", () => {
  // «Given two runs whose durations differ, then no verdict depends on a duration» (LOC-01).
  it("move no verdict: the same composition with durations a thousand times apart is unchanged", () => {
    const slow = runOf({ route: "/p", requests: 3, operations: [Q("a", 3, 3000), CALL("api", 3)], meanMs: 5000 });
    const fast = runOf({ route: "/p", requests: 3, operations: [Q("a", 3, 3), CALL("api", 3)], meanMs: 5 });
    for (const [base, change] of [
      [fast, slow],
      [slow, fast],
    ] as const) {
      expect(only(base, change, "GET /p").verdict).toBe("unchanged");
    }
  });

  it("move no verdict on a route that did get worse either: only the composition decides", () => {
    const base = runOf({ route: "/p", requests: 3, operations: [Q("a", 3, 3)], meanMs: 5 });
    const slower = runOf({ route: "/p", requests: 3, operations: [Q("a", 3, 3), Q("n", 3, 9000)], meanMs: 9000 });
    const faster = runOf({ route: "/p", requests: 3, operations: [Q("a", 3, 3), Q("n", 3, 0)], meanMs: 0.1 });
    expect(only(base, slower, "GET /p").verdict).toBe("worse");
    expect(only(base, faster, "GET /p").verdict).toBe("worse");
  });

  it("are shown beside the verdict, as data", () => {
    const base = runOf({ route: "/p", requests: 2, operations: [Q("a", 2, 4)], meanMs: 10 });
    const change = runOf({ route: "/p", requests: 2, operations: [Q("a", 2, 8)], meanMs: 30 });
    const route = only(base, change, "GET /p");
    expect(route.meanRequestMs).toEqual({ base: 10, change: 30 });
    expect(route.operations[0]?.msPerExecution).toEqual({ base: 2, change: 4 });
  });
});

describe("what is not evaluated, and why (COB-01, ESC-18)", () => {
  /** One scenario per reason: the table is checked against the source's own list below. */
  const SCENARIOS: Record<NotEvaluatedReason, () => RouteResult> = {
    "not-called": () =>
      compareRuns(runOf(), runOf(), ["GET /orders"]).find((route) => route.id === "GET /orders") as RouteResult,
    "not-called-in-base": () =>
      only(runOf(), runOf({ route: "/new", requests: 2, operations: [Q("a", 2)] }), "GET /new"),
    "not-called-in-change": () =>
      only(runOf({ route: "/old", requests: 2, operations: [Q("a", 2)] }), runOf(), "GET /old"),
    "no-profile-in-base": () =>
      only(
        runOf({ route: "/p", requests: 2, operations: [Q("a", 2)], profiled: false }),
        runOf({ route: "/p", requests: 2, operations: [Q("a", 2)] }),
        "GET /p",
      ),
    "no-profile-in-change": () =>
      only(
        runOf({ route: "/p", requests: 2, operations: [Q("a", 2)] }),
        runOf({ route: "/p", requests: 2, operations: [Q("a", 2)], profiled: false }),
        "GET /p",
      ),
    "nothing-observed": () =>
      only(runOf({ route: "/health", requests: 4 }), runOf({ route: "/health", requests: 4 }), "GET /health"),
    bucket: () =>
      only(
        runOf({ route: "(unmatched)", requests: 2, operations: [Q("a", 2)] }),
        runOf({ route: "(unmatched)", requests: 9, operations: [Q("a", 90), Q("b", 9)] }),
        "GET (unmatched)",
      ),
  };

  it("has a scenario for every reason there is, and a message for each", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...NOT_EVALUATED_REASONS].sort());
  });

  it.each(NOT_EVALUATED_REASONS)("%s: the route is not evaluated, says so, and is never unchanged", (code) => {
    const route = SCENARIOS[code]();
    expect(route.verdict).toBe("not-evaluated");
    expect(route.reasons.map((reason) => reason.code)).toContain(code);
    expect(route.reasons.every((reason) => reason.message.length > 10)).toBe(true);
    expect(route.operations).toEqual([]);
  });

  it("names a route no test calls, when the project declares it: nothing else could", () => {
    const routes = compareRuns(
      runOf({ route: "/p", requests: 2, operations: [Q("a", 2)] }),
      runOf({ route: "/p", requests: 2, operations: [Q("a", 2)] }),
      ["GET /p", "GET /orders"],
    );
    expect(routes.map((route) => [route.id, route.verdict])).toEqual([
      ["GET /p", "unchanged"],
      ["GET /orders", "not-evaluated"],
    ]);
  });

  it("is said for each side that lost it, with what that side saw", () => {
    const route = only(
      runOf({ route: "/p", requests: 7, operations: [Q("a", 7)], profiled: false }),
      runOf({ route: "/p", requests: 2, operations: [Q("a", 2)], profiled: false }),
      "GET /p",
    );
    expect(route.reasons.map((reason) => reason.code)).toEqual(["no-profile-in-base", "no-profile-in-change"]);
    expect(route.requests).toEqual({ base: 7, change: 2 });
    expect(route.profiledRequests).toEqual({ base: 0, change: 0 });
  });

  it("is not made evaluated by an operation appearing where nothing was profiled", () => {
    const route = only(
      runOf({ route: "/p", requests: 2, operations: [Q("a", 2)], profiled: false }),
      runOf({ route: "/p", requests: 2, operations: [Q("a", 2), Q("n", 20)] }),
      "GET /p",
    );
    expect(route.verdict).toBe("not-evaluated");
  });
});

describe("buckets are not routes", () => {
  it("lists them by name and never judges them, however much was in them", () => {
    for (const bucket of BUCKET_ROUTES) {
      const route = only(
        runOf({ route: bucket, requests: 2, operations: [Q("a", 2)] }),
        runOf({ route: bucket, requests: 50, operations: [Q("a", 500), Q("new", 50)] }),
        `GET ${bucket}`,
      );
      expect(route.verdict, bucket).toBe("not-evaluated");
      expect(route.reasons.map((reason) => reason.code)).toEqual(["bucket"]);
    }
  });

  it("names the three buckets the instrumentation uses", () => {
    expect([...BUCKET_ROUTES].sort()).toEqual(["(other)", "(unmatched)", "/_not-found"]);
  });

  it("does not let how many requests fall in one change what is said of a route beside it", () => {
    const base = runOf(
      { route: "/p", requests: 3, operations: [Q("a", 3)] },
      { route: "(unmatched)", requests: 1, operations: [Q("x", 1)] },
    );
    const change = runOf(
      { route: "/p", requests: 3, operations: [Q("a", 3)] },
      { route: "(unmatched)", requests: 40, operations: [Q("x", 400)] },
    );
    const routes = compareRuns(base, change);
    expect(routes.find((route) => route.id === "GET /p")?.verdict).toBe("unchanged");
    expect(summarize(routes)).toEqual({ worse: 0, unchanged: 1, notEvaluated: 1 });
  });
});

describe("what a route with nothing observed is", () => {
  it("not evaluated when no query, call or command ran in it, in either run: nothing to compare", () => {
    const route = only(
      runOf({ route: "/health", requests: 5 }),
      runOf({ route: "/health", requests: 5 }),
      "GET /health",
    );
    expect(route.verdict).toBe("not-evaluated");
    expect(route.reasons[0]?.code).toBe("nothing-observed");
  });

  it("worse, when the change is the one that starts running something: that is composition", () => {
    const route = only(
      runOf({ route: "/health", requests: 5 }),
      runOf({ route: "/health", requests: 5, operations: [Q("n", 5)] }),
      "GET /health",
    );
    expect(route.verdict).toBe("worse");
  });
});

describe("the verdicts together", () => {
  it("counts them, worse first and what was not evaluated last", () => {
    const base = runOf(
      { route: "/a", requests: 2, operations: [Q("a", 2)] },
      { route: "/b", requests: 2, operations: [Q("a", 2)] },
      { route: "/c", requests: 2 },
    );
    const change = runOf(
      { route: "/a", requests: 2, operations: [Q("a", 2), Q("n", 2)] },
      { route: "/b", requests: 2, operations: [Q("a", 2)] },
      { route: "/c", requests: 2 },
    );
    const routes = compareRuns(base, change, ["GET /d"]);
    expect(routes.map((route) => [route.id, route.verdict])).toEqual([
      ["GET /a", "worse"],
      ["GET /b", "unchanged"],
      ["GET /c", "not-evaluated"],
      ["GET /d", "not-evaluated"],
    ]);
    expect(summarize(routes)).toEqual({ worse: 1, unchanged: 1, notEvaluated: 2 });
  });

  it("never says unchanged of a route it did not evaluate", () => {
    const routes = compareRuns(
      runOf({ route: "/a", requests: 2 }, { route: "/gone", requests: 1, operations: [Q("a", 1)] }),
      runOf({ route: "/a", requests: 2 }, { route: "(unmatched)", requests: 1 }),
      ["GET /never"],
    );
    for (const route of routes) {
      if (route.reasons.length > 0) expect(route.verdict, route.id).toBe("not-evaluated");
      if (route.verdict === "unchanged") expect(route.reasons).toEqual([]);
    }
  });
});
