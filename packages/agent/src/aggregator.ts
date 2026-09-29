import {
  CALLS_PER_REQUEST_BUCKETS_V0,
  callsPerRequestBucket,
  DEPENDENCIES_MAX_ITEMS_V0,
  DEPENDENCY_KINDS_V0,
  type Dependency,
  type Endpoint,
  type Interval,
  LATENCY_BUCKETS_V0,
  type LatencyHistogram,
  latencyBucket,
} from "@downtrace/protocol";
import { type DependencyKind, type DependencyWork, dependencyKey } from "./context.ts";
import { type Method, OTHER_ROUTE } from "./routes.ts";

/** The target the dependencies past the per-route cap fold into, one row of their own kind (gh-776). */
export const OTHER_DEPENDENCY_TARGET = "(other)";

/**
 * How many distinct dependencies keep their own row per route and interval: the schema's `maxItems` for
 * `dependencies` minus the kinds it names, which is how many `(other)` rows, one per kind, may still fit
 * beside them. Both values are the schema's, generated into the protocol (gh-776): a list that outgrew the
 * cap made the cloud refuse the batch, and a refused batch is dropped whole, every route's interval with it.
 */
export const MAX_KEPT_DEPENDENCIES = DEPENDENCIES_MAX_ITEMS_V0 - DEPENDENCY_KINDS_V0.length;

/** Per-route accumulator with preallocated histogram buckets. */
interface EndpointAcc {
  method: Method;
  route: string;
  count: number;
  errors: number;
  success: number;
  redirect: number;
  clientError: number;
  serverError: number;
  counts: Uint32Array;
  sum: number;
  max: number;
  /**
   * One accumulator per dependency this route touched, up to `MAX_KEPT_DEPENDENCIES`, plus the `(other)` row
   * of each kind past the cap; only allocated when a call was actually observed.
   */
  deps: Map<string, DependencyAcc> | undefined;
  /** How many of those rows are kept dependencies, as opposed to `(other)` rows: the cap is counted on them. */
  keptDeps: number;
}

interface DependencyAcc {
  kind: DependencyKind;
  target: string;
  counts: Uint32Array;
  sum: number;
  max: number;
  errors: number;
  wait: number;
}

export interface Recorder {
  record(
    method: Method,
    route: string,
    status: number,
    ms: number,
    work?: Map<string, DependencyWork> | undefined,
  ): void;
  rotate(): Interval | null;
}

export const DEFAULT_MAX_ROUTES = 500;

export interface IntervalOptions {
  /**
   * The agent's clock, which every instant it produces comes from (`AgentDeps.now`). Required, with no default:
   * a default is how this read the wall clock in production while the agent's clock was somewhere else, with
   * every unit test green (gh-610, ADR 0126).
   */
  now: () => number;
  maxRoutes?: number | undefined;
}

/**
 * Aggregates finished requests for the current interval. Memory is bounded:
 * at most `maxRoutes` distinct routes per interval, the rest fold into (other).
 */
export class IntervalAggregator implements Recorder {
  private endpoints = new Map<string, EndpointAcc>();
  private distinctRoutes = 0;
  private start: number;
  private readonly maxRoutes: number;
  private readonly now: () => number;

  constructor(options: IntervalOptions) {
    this.maxRoutes = options.maxRoutes ?? DEFAULT_MAX_ROUTES;
    this.now = options.now;
    this.start = this.now();
  }

  get size(): number {
    return this.endpoints.size;
  }

  record(
    method: Method,
    route: string,
    status: number,
    ms: number,
    work?: Map<string, DependencyWork> | undefined,
  ): void {
    let key = `${method} ${route}`;
    let acc = this.endpoints.get(key);
    if (!acc) {
      if (route !== OTHER_ROUTE && this.distinctRoutes >= this.maxRoutes) {
        route = OTHER_ROUTE;
        key = `${method} ${OTHER_ROUTE}`;
        acc = this.endpoints.get(key);
      } else if (route !== OTHER_ROUTE) {
        this.distinctRoutes += 1;
      }
      if (!acc) {
        acc = {
          method,
          route,
          count: 0,
          errors: 0,
          success: 0,
          redirect: 0,
          clientError: 0,
          serverError: 0,
          counts: new Uint32Array(LATENCY_BUCKETS_V0),
          sum: 0,
          max: 0,
          deps: undefined,
          keptDeps: 0,
        };
        this.endpoints.set(key, acc);
      }
    }
    acc.count += 1;
    if (status >= 500) {
      acc.serverError += 1;
      acc.errors += 1;
    } else if (status >= 400) acc.clientError += 1;
    else if (status >= 300) acc.redirect += 1;
    else acc.success += 1;
    const latency = ms >= 0 ? ms : 0;
    const bucket = latencyBucket(latency);
    acc.counts[bucket] = (acc.counts[bucket] ?? 0) + 1;
    acc.sum += latency;
    if (latency > acc.max) acc.max = latency;
    if (work) {
      // Only requests served while a driver was instrumented carry work; the field stays absent otherwise.
      acc.deps ??= new Map();
      // What falls into a kind's `(other)` row this request, summed by kind before the calls-per-request
      // bucket is counted: a request that talks to three folded targets of a kind is one request with their
      // calls added, not three (gh-776).
      let folded: Map<DependencyKind, DependencyWork> | undefined;
      for (const [key, w] of work) {
        const dep = acc.deps.get(key);
        if (dep !== undefined) {
          addWork(dep, w);
          continue;
        }
        if (acc.keptDeps < MAX_KEPT_DEPENDENCIES) {
          const kept = newDependency(w.kind, w.target);
          acc.deps.set(key, kept);
          acc.keptDeps += 1;
          addWork(kept, w);
        } else {
          // Past the cap, a destination never gets a row of its own: it folds into its kind's `(other)` row.
          // Nothing remembers which destinations folded — once the cap is reached, every destination that
          // has no row folds, which is the same decision made twice.
          folded ??= new Map();
          const f = folded.get(w.kind);
          if (f === undefined) folded.set(w.kind, { ...w });
          else {
            f.calls += w.calls;
            f.ms += w.ms;
            if (w.maxMs > f.maxMs) f.maxMs = w.maxMs;
            f.errors += w.errors;
            f.waitMs += w.waitMs;
          }
        }
      }
      for (const [kind, w] of folded ?? []) {
        const other = otherRowOf(acc.deps, kind);
        addWork(other, w);
      }
    }
  }

  /** Closes the current interval and starts a new one. Returns null when nothing was recorded. */
  rotate(): Interval | null {
    const now = this.now();
    const start = this.start;
    const endpoints = this.endpoints;
    this.endpoints = new Map();
    this.distinctRoutes = 0;
    this.start = now;
    if (endpoints.size === 0) return null;
    const out: Endpoint[] = [];
    for (const acc of endpoints.values()) {
      const dependencies: Dependency[] | undefined = acc.deps
        ? [...acc.deps.values()].map((d) => ({
            kind: d.kind,
            target: d.target,
            callsPerRequest: Array.from(d.counts) as Dependency["callsPerRequest"],
            totalMs: round3(d.sum),
            max: round3(d.max),
            errors: d.errors,
            // Only sent when there was something to say: a driver that cannot report waiting omits the field.
            ...(d.wait > 0 ? { waitMs: round3(d.wait) } : {}),
          }))
        : undefined;
      out.push({
        method: acc.method,
        route: acc.route,
        count: acc.count,
        errors: acc.errors,
        status: {
          success: acc.success,
          redirect: acc.redirect,
          clientError: acc.clientError,
          serverError: acc.serverError,
        },
        // The schema fixes the length at LATENCY_BUCKETS_V0; the generated type is a tuple of that size.
        latency: {
          counts: Array.from(acc.counts) as LatencyHistogram["counts"],
          sum: round3(acc.sum),
          max: round3(acc.max),
        },
        ...(dependencies ? { dependencies } : {}),
      });
    }
    // Rounded here, where the interval becomes what the batch carries, and not in `start`: the contract's
    // instants are integers and the agent's clock is not (ADR 0145).
    return { start: Math.floor(start), durationMs: Math.max(1, Math.round(now - start)), endpoints: out };
  }
}

function newDependency(kind: DependencyKind, target: string): DependencyAcc {
  return {
    kind,
    target,
    counts: new Uint32Array(CALLS_PER_REQUEST_BUCKETS_V0),
    sum: 0,
    max: 0,
    errors: 0,
    wait: 0,
  };
}

/** The `(other)` row of one kind, created on first fold: it is a row like any other, only its target is the bucket. */
function otherRowOf(deps: Map<string, DependencyAcc>, kind: DependencyKind): DependencyAcc {
  const key = dependencyKey(kind, OTHER_DEPENDENCY_TARGET);
  let row = deps.get(key);
  if (row === undefined) {
    row = newDependency(kind, OTHER_DEPENDENCY_TARGET);
    deps.set(key, row);
  }
  return row;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** What one request's work adds to one dependency's accumulator. */
function addWork(dep: DependencyAcc, w: DependencyWork): void {
  const callBucket = callsPerRequestBucket(w.calls);
  dep.counts[callBucket] = (dep.counts[callBucket] ?? 0) + 1;
  dep.sum += w.ms;
  if (w.maxMs > dep.max) dep.max = w.maxMs;
  dep.errors += w.errors;
  dep.wait += w.waitMs;
}
