import {
  type Endpoint,
  type Interval,
  LATENCY_BUCKETS_V0,
  type LatencyHistogram,
  latencyBucket,
} from "@downtrace/protocol";
import { type Method, OTHER_ROUTE } from "./routes.ts";

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
}

export interface Recorder {
  record(method: Method, route: string, status: number, ms: number): void;
  rotate(): Interval | null;
}

export const DEFAULT_MAX_ROUTES = 500;

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

  constructor(maxRoutes = DEFAULT_MAX_ROUTES, now: () => number = Date.now) {
    this.maxRoutes = maxRoutes;
    this.now = now;
    this.start = now();
  }

  get size(): number {
    return this.endpoints.size;
  }

  record(method: Method, route: string, status: number, ms: number): void {
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
      });
    }
    return { start: Math.floor(start), durationMs: Math.max(1, Math.round(now - start)), endpoints: out };
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
