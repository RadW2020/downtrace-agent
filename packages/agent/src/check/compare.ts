import {
  COMPOSITION_KINDS,
  type CompositionKind,
  type OperationTally,
  type RouteTally,
  type RunTally,
} from "./read.ts";

/**
 * The comparison before the deploy, route by route, by composition (LOC-01).
 *
 * It answers one of three things for each route: **worse**, **unchanged** or **not evaluated**. What it never
 * does is read a duration into the answer: the traffic of a test run is not production's and the machine it runs
 * on is not quiet, so durations travel as data beside the verdict and no branch below looks at them. And what it
 * never does is turn *«there is nothing to compare»* into *«nothing changed»*: a route a run did not call, did
 * not profile, or ran with nothing observed on it is not evaluated, and says why (COB-01).
 */

/**
 * How much an operation must repeat more per request, relative to the base, to be called multiplied. Together
 * with the absolute floor below: a ratio alone fires on a fifth of an execution becoming a quarter, and a floor
 * alone fires on a third more of something that already ran forty times. An operation that did not run at all in
 * the base needs neither: it appeared.
 */
export const MIN_RISE_RATIO = 1.25;
/** How many executions per request an operation must gain, whatever its ratio. */
export const MIN_RISE_PER_REQUEST = 0.5;

export type Verdict = "worse" | "unchanged" | "not-evaluated";

/** Why a route was not evaluated. Stable: an agent branches on these. */
export const NOT_EVALUATED_REASONS = [
  "bucket",
  "not-called",
  "not-called-in-base",
  "not-called-in-change",
  "no-profile-in-base",
  "no-profile-in-change",
  "nothing-observed",
] as const;
export type NotEvaluatedReason = (typeof NOT_EVALUATED_REASONS)[number];

/** What each reason says. The two `no-profile` ones are completed with what is known of the run, where it is said. */
const REASON_MESSAGES: Record<NotEvaluatedReason, string> = {
  bucket:
    "a bucket of requests and not a route of the project — what no route matched, or what went past the cap of " +
    "routes: what it ran is a mix, and how many requests fall in it depends on the tests, so it is not judged",
  "not-called": "no request reached it in either run",
  "not-called-in-base": "the base run made no request to it: it is new, or the tests only reach it now",
  "not-called-in-change": "the change run made no request to it: it is gone, or the tests no longer reach it",
  "no-profile-in-base": "the base run saw requests to it and no profile covered them",
  "no-profile-in-change": "the change run saw requests to it and no profile covered them",
  "nothing-observed":
    "no query, outgoing call or Redis command was observed inside its requests, in either run: it has none, or " +
    "its dependencies were simulated or are not observed, and with nothing to compare nothing is said",
};

export interface NotEvaluated {
  code: NotEvaluatedReason;
  message: string;
}

/** How one operation moved. `appeared` and `multiplied` are the two that make a route worse. */
export type OperationChange = "appeared" | "multiplied" | "unchanged" | "reduced" | "disappeared";

export interface Pair<T> {
  base: T;
  change: T;
}

export interface OperationResult {
  /** Stable between runs: the kind and the fingerprint. */
  id: string;
  kind: CompositionKind;
  /** The protocol's fingerprint; null where several of them were folded into one operation (a loopback port). */
  hash: string | null;
  /** What it is called, when the text travelled. */
  label: string | null;
  change: OperationChange;
  worse: boolean;
  /** Executions per request, over the requests whose composition is known. */
  perRequest: Pair<number>;
  executions: Pair<number>;
  /** Data, never judged. */
  msPerExecution: Pair<number | null>;
}

/** Everything one kind of dependency did for a route: all its queries, all its outgoing calls, all its commands. */
export interface DependencyResult {
  kind: CompositionKind;
  perRequest: Pair<number>;
  worse: boolean;
}

export interface RouteResult {
  /** `POST /checkout`: the method and the template, which is how a route is named in every run. */
  id: string;
  method: string;
  route: string;
  verdict: Verdict;
  /** Why it was not evaluated; empty for the other two verdicts. */
  reasons: NotEvaluated[];
  /** What each side saw of it. */
  requests: Pair<number>;
  /** Of those, the requests whose composition is known: what the executions are divided by. */
  profiledRequests: Pair<number>;
  /** Empty when the route was not evaluated. */
  operations: OperationResult[];
  dependencies: DependencyResult[];
  /** The mean duration of a request, in milliseconds: data. Null where a side saw none. */
  meanRequestMs: Pair<number | null>;
}

/**
 * Names the instrumentation gives to requests that belong to no route: `(unmatched)` for what no route of the
 * framework matched, `/_not-found` for Next.js's own, `(other)` for what went past the cap of routes. They are
 * buckets, and a bucket has no composition of its own: whatever hit it is a mix, and the tests decide how many
 * do. They are listed by name and never judged, so that a change in how many requests fall in one is never read
 * as «the route got worse».
 */
export const BUCKET_ROUTES: readonly string[] = ["(unmatched)", "/_not-found", "(other)"];

function isBucket(...routes: Array<RouteTally | undefined>): boolean {
  return routes.some((tally) => tally !== undefined && BUCKET_ROUTES.includes(tally.route));
}

function perRequest(operation: OperationTally | undefined, requests: number): number {
  return operation === undefined || requests === 0 ? 0 : operation.executions / requests;
}

function msPerExecution(operation: OperationTally | undefined): number | null {
  return operation === undefined || operation.executions === 0 ? null : operation.totalMs / operation.executions;
}

function classify(base: number, change: number): OperationChange {
  if (base === 0) return change === 0 ? "unchanged" : "appeared";
  if (change === 0) return "disappeared";
  if (change >= base * MIN_RISE_RATIO && change - base >= MIN_RISE_PER_REQUEST) return "multiplied";
  if (base >= change * MIN_RISE_RATIO && base - change >= MIN_RISE_PER_REQUEST) return "reduced";
  return "unchanged";
}

/** What is said when a run saw requests and no profile covered them, which the advice on the command completes. */
function whySide(side: "base" | "change", route: RouteTally): string {
  return (
    `the ${side} run saw ${route.requests} request${route.requests === 1 ? "" : "s"} to it and no profile covered ` +
    "them, so what they ran is unknown"
  );
}

function notEvaluated(
  id: string,
  base: RouteTally | undefined,
  change: RouteTally | undefined,
  reasons: NotEvaluated[],
): RouteResult {
  return {
    ...shell(id, base, change),
    verdict: "not-evaluated",
    reasons,
    operations: [],
    dependencies: [],
  };
}

function shell(
  id: string,
  base: RouteTally | undefined,
  change: RouteTally | undefined,
): Pick<RouteResult, "id" | "method" | "route" | "requests" | "profiledRequests" | "meanRequestMs"> {
  const own = base ?? change;
  const [method = "", ...rest] = id.split(" ");
  const mean = (tally: RouteTally | undefined): number | null =>
    tally === undefined || tally.requests === 0 ? null : tally.durationMs / tally.requests;
  return {
    id,
    method: own?.method ?? method,
    route: own?.route ?? rest.join(" "),
    requests: { base: base?.requests ?? 0, change: change?.requests ?? 0 },
    profiledRequests: { base: base?.profiledRequests ?? 0, change: change?.profiledRequests ?? 0 },
    meanRequestMs: { base: mean(base), change: mean(change) },
  };
}

/** One route, on both sides. `base` and `change` are undefined where a side never saw it. */
export function evaluateRoute(id: string, base: RouteTally | undefined, change: RouteTally | undefined): RouteResult {
  if (isBucket(base, change)) {
    return notEvaluated(id, base, change, [{ code: "bucket", message: REASON_MESSAGES.bucket }]);
  }
  if (base === undefined || base.requests === 0) {
    const code = change === undefined || change.requests === 0 ? "not-called" : "not-called-in-base";
    return notEvaluated(id, base, change, [{ code, message: REASON_MESSAGES[code] }]);
  }
  if (change === undefined || change.requests === 0) {
    return notEvaluated(id, base, change, [
      { code: "not-called-in-change", message: REASON_MESSAGES["not-called-in-change"] },
    ]);
  }
  const unprofiled: NotEvaluated[] = [];
  if (base.profiledRequests === 0) unprofiled.push({ code: "no-profile-in-base", message: whySide("base", base) });
  if (change.profiledRequests === 0) {
    unprofiled.push({ code: "no-profile-in-change", message: whySide("change", change) });
  }
  if (unprofiled.length > 0) return notEvaluated(id, base, change, unprofiled);

  const operations: OperationResult[] = [];
  const add = (known: OperationTally, was: OperationTally | undefined, is: OperationTally | undefined): void => {
    const perBase = perRequest(was, base.profiledRequests);
    const perChange = perRequest(is, change.profiledRequests);
    const moved = classify(perBase, perChange);
    operations.push({
      id: known.id,
      kind: known.kind,
      hash: known.hash ?? null,
      label: known.label ?? null,
      change: moved,
      worse: moved === "appeared" || moved === "multiplied",
      perRequest: { base: perBase, change: perChange },
      executions: { base: was?.executions ?? 0, change: is?.executions ?? 0 },
      msPerExecution: { base: msPerExecution(was), change: msPerExecution(is) },
    });
  };
  for (const [operationId, was] of base.operations) add(was, was, change.operations.get(operationId));
  for (const [operationId, is] of change.operations) if (!base.operations.has(operationId)) add(is, undefined, is);
  if (operations.length === 0) {
    return notEvaluated(id, base, change, [{ code: "nothing-observed", message: REASON_MESSAGES["nothing-observed"] }]);
  }
  // What moved most first: the reader came for the operation that appeared and how many times it repeats.
  operations.sort((a, b) => {
    if (a.worse !== b.worse) return a.worse ? -1 : 1;
    const moved = Math.abs(b.perRequest.change - b.perRequest.base) - Math.abs(a.perRequest.change - a.perRequest.base);
    if (moved !== 0) return moved;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const dependencies: DependencyResult[] = [];
  for (const kind of COMPOSITION_KINDS) {
    const ofKind = operations.filter((operation) => operation.kind === kind);
    if (ofKind.length === 0) continue;
    dependencies.push({
      kind,
      perRequest: {
        base: ofKind.reduce((sum, operation) => sum + operation.perRequest.base, 0),
        change: ofKind.reduce((sum, operation) => sum + operation.perRequest.change, 0),
      },
      worse: ofKind.some((operation) => operation.worse),
    });
  }

  return {
    ...shell(id, base, change),
    verdict: operations.some((operation) => operation.worse) ? "worse" : "unchanged",
    reasons: [],
    operations,
    dependencies,
  };
}

const RANK: Record<Verdict, number> = { worse: 0, unchanged: 1, "not-evaluated": 2 };

/**
 * Every route either run saw, and every route the project declares: the declared ones are what lets a route no
 * test calls be named, because nothing observes a route nobody asked.
 */
export function compareRuns(base: RunTally, change: RunTally, declared: readonly string[] = []): RouteResult[] {
  const ids = new Set([...declared, ...base.routes.keys(), ...change.routes.keys()]);
  const results = [...ids].map((id) => evaluateRoute(id, base.routes.get(id), change.routes.get(id)));
  return results.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface Summary {
  worse: number;
  unchanged: number;
  notEvaluated: number;
}

export function summarize(routes: readonly RouteResult[]): Summary {
  return {
    worse: routes.filter((route) => route.verdict === "worse").length,
    unchanged: routes.filter((route) => route.verdict === "unchanged").length,
    notEvaluated: routes.filter((route) => route.verdict === "not-evaluated").length,
  };
}
