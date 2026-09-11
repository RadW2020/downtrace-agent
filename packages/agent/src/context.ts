import { AsyncLocalStorage } from "node:async_hooks";
import type { Dependency } from "@downtrace/protocol";
import type { FineRegister } from "./fine.ts";
import type { QueryClass } from "./fingerprint.ts";

export type DependencyKind = Dependency["kind"];

/** What one request did against one dependency. Counters only: never the query text, never the values. */
export interface DependencyWork {
  kind: DependencyKind;
  target: string;
  calls: number;
  ms: number;
  maxMs: number;
  errors: number;
  /** Time spent waiting to be able to talk to this dependency, rather than talking to it. */
  waitMs: number;
}

/**
 * One fingerprint's worth of work inside one request: what was run, how often, and how long it took.
 * Never the values — the text is normalised before it ever reaches here (`fingerprint.ts`, invariant 5).
 */
export interface OperationWork {
  kind: "query" | "error";
  hash: string;
  /** Normalised text. Empty when there is nothing readable to label it with. */
  text: string;
  /** Set instead of the text when the query was not understood, and then it is the whole label (gh-347). */
  class?: QueryClass;
  count: number;
  totalMs: number;
  errors: number;
}

/**
 * What one in-flight request has done so far, by dependency. The map is created on the first call, so a request
 * that touches nothing costs one object rather than one object and a map.
 */
export interface RequestContext {
  work: Map<string, DependencyWork> | undefined;
  /**
   * The dependency targets the operator asked not to be looked at, or nothing when they asked for none.
   * Carried here rather than reached for: this runs per call, and the agent is not reachable from a free
   * function without making it global (`product.md:104`, ADR 0101).
   */
  excluded?: { has(target: string): boolean } | undefined;
  /**
   * Turns a dependency target into what may leave the process. Identity in minimal mode, the host itself
   * otherwise. Carried here for the same reason as `excluded`: this runs per call, and reaching the agent
   * from a free function would mean making it global (ADR 0105).
   */
  named?: ((target: string) => string) | undefined;
  /** What this request ran, by fingerprint. Created on the first operation, like `work`. */
  operations: Map<string, OperationWork> | undefined;
  /** How many calls have been recorded, so an observer can tell whether anything saw a given call. */
  recorded: number;
  /**
   * The black box's fine register, or undefined when nothing is keeping one. Passed in rather than reached for:
   * a module-level singleton would be global state, and this file is on the hot path of every request.
   */
  fine: FineRegister | undefined;
  /** `performance.now()` when the request started, so an operation's offsets are relative to it. */
  startedAt: number;
  /** The absolute operation cursor this request's operations begin at. */
  fineFrom: number;
  /**
   * How many operations this request ran, **including** the ones past the per-request cap. The count and what
   * was written differ on purpose: that difference is how a truncated request says so instead of passing for a
   * small one.
   */
  fineOps: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Key of a dependency within one request: its kind and, for outgoing HTTP, the host.
 *
 * It is also the label the black box keeps per request and the one a capture of a dependency is matched
 * against (gh-397). Exported so both sides build it here and not each in its own way — and the strings it
 * makes are the ones `work` is already keyed by, so keeping them costs no allocation on the hot path.
 */
export function dependencyKey(kind: string, target: string): string {
  return target === "" ? kind : `${kind}\0${target}`;
}

/**
 * Opens the context for a request. Called from the `http.server.request.start` subscriber, which Node publishes
 * inside the request's own async context, so `enterWith` reaches the handler and everything it awaits. Verified
 * against concurrent keep-alive traffic: each request counts its own work.
 */
export function enterRequest(
  fine?: FineRegister,
  startedAt = performance.now(),
  excluded?: { has(target: string): boolean },
  named?: (target: string) => string,
): RequestContext {
  const ctx: RequestContext = {
    work: undefined,
    operations: undefined,
    recorded: 0,
    fine,
    startedAt,
    fineFrom: fine ? fine.openRequest() : 0,
    fineOps: 0,
    excluded,
    named,
  };
  storage.enterWith(ctx);
  return ctx;
}

/** The context of the request being served, or undefined outside one (a background job, a startup query). */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Records one finished call against the current request. Work outside a request is not attributed to any route:
 * a query at startup belongs to no endpoint.
 */
export function recordCall(kind: DependencyKind, target: string, ms: number, failed = false): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  recordCallIn(ctx, kind, target, ms, failed);
}

/**
 * Records a call against a context captured earlier. Some observation points fire outside the async context of
 * whoever made the call (an HTTP response arrives on the connection's context, not the caller's), so the context
 * is captured when the call starts and the result is recorded into it here.
 */
export function recordCallIn(
  ctx: RequestContext,
  kind: DependencyKind,
  target: string,
  ms: number,
  failed = false,
): void {
  // What the operator asked not to be looked at is not looked at, here as well as at the route
  // (`product.md:104`, ADR 0101). The context carries the decision because this runs per call and the
  // agent is not reachable from here without making it global.
  if (ctx.excluded?.has(target)) return;
  const named = ctx.named ? ctx.named(target) : target;
  ctx.work ??= new Map();
  const key = dependencyKey(kind, named);
  let entry = ctx.work.get(key);
  if (!entry) {
    entry = { kind, target: named, calls: 0, ms: 0, maxMs: 0, errors: 0, waitMs: 0 };
    ctx.work.set(key, entry);
  }
  ctx.recorded += 1;
  entry.calls += 1;
  entry.ms += ms;
  if (ms > entry.maxMs) entry.maxMs = ms;
  if (failed) entry.errors += 1;
}

/**
 * Records time spent waiting to reach a dependency, before any call is made. A connection pool with nothing free
 * shows up here: the request is not slow because the database is slow, it is slow because it never got to talk
 * to it.
 */
export function recordWaitIn(ctx: RequestContext, kind: DependencyKind, target: string, ms: number): void {
  if (ctx.excluded?.has(target)) return;
  const named = ctx.named ? ctx.named(target) : target;
  ctx.work ??= new Map();
  const key = dependencyKey(kind, named);
  let entry = ctx.work.get(key);
  if (!entry) {
    entry = { kind, target: named, calls: 0, ms: 0, maxMs: 0, errors: 0, waitMs: 0 };
    ctx.work.set(key, entry);
  }
  entry.waitMs += ms;
}

/** As above, against the request being served. */
export function recordWait(kind: DependencyKind, target: string, ms: number): void {
  const ctx = storage.getStore();
  if (ctx) recordWaitIn(ctx, kind, target, ms);
}

/**
 * One finished operation, as the instrumentation reports it. An object rather than six positional arguments,
 * two of which would be numbers that mean different things (repo rule).
 */
export interface FinishedOperation {
  kind: OperationWork["kind"];
  /** Never the values: the text is normalised before it reaches here (`fingerprint.ts`, invariant 5). */
  fingerprint: { hash: string; text: string; class?: QueryClass };
  /** `performance.now()` when it started and when it finished. */
  startedAt: number;
  endedAt: number;
  failed?: boolean;
}

/**
 * Records one finished operation against a context captured earlier, alongside the dependency counters.
 *
 * Kept separate from `recordCallIn` because the two answer different questions and are capped differently: how
 * much a request talked to Postgres is one number per dependency, and what it ran is one entry per fingerprint.
 */
export function recordOperationIn(ctx: RequestContext, op: FinishedOperation): void {
  const ms = op.endedAt - op.startedAt;
  ctx.operations ??= new Map();
  let entry = ctx.operations.get(op.fingerprint.hash);
  if (!entry) {
    entry = {
      kind: op.kind,
      hash: op.fingerprint.hash,
      text: op.fingerprint.text,
      count: 0,
      totalMs: 0,
      errors: 0,
    };
    if (op.fingerprint.class !== undefined) entry.class = op.fingerprint.class;
    ctx.operations.set(op.fingerprint.hash, entry);
  }
  entry.count += 1;
  entry.totalMs += ms;
  if (op.failed) entry.errors += 1;

  // And into the black box, which keeps the sequence the map above throws away: an aggregate says a route ran
  // fifty-six queries, and only starts and ends say whether they ran one after another (ATR-01).
  //
  // Counted past the cap and written only up to it: a request that runs a hundred thousand queries must not
  // empty the ring for everybody else, and must not pass for a small one either.
  if (ctx.fine) {
    ctx.fineOps += 1;
    if (ctx.fineOps <= ctx.fine.operationsPerRequest) {
      ctx.fine.operation(op.fingerprint.hash, op.startedAt - ctx.startedAt, op.endedAt - ctx.startedAt);
    }
  }
}
