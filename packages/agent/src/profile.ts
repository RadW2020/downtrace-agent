import type { Operation, Profile, ProfileEndpoint } from "@downtrace/protocol";
import { DEFAULT_MAX_ROUTES } from "./aggregator.ts";
import type { OperationWork } from "./context.ts";
import { type Method, OTHER_ROUTE } from "./routes.ts";

/**
 * What each route normally does, as opposed to how it performed.
 *
 * A profile changes when the code changes, so it goes out once a minute rather than with every interval: at the
 * aggregates' cadence it would repeat itself six times a minute and would not fit in the project's row budget
 * (ADR 0017, invariant 8).
 */

/** One minute, the cadence the ADR fixed. */
export const PROFILE_WINDOW_MS = 60_000;

/** Fingerprints kept per endpoint. Plus the bucket, this is the schema's `maxItems: 64`. */
export const DEFAULT_MAX_OPERATIONS = 63;

/** The bucket that holds everything past the cap. */
export const OTHER_OPERATION = "(other)";

export interface ProfileOptions {
  now?: (() => number) | undefined;
  maxRoutes?: number | undefined;
  maxOperations?: number | undefined;
  /** Off suppresses the normalised text and nothing else: the hash is the identity (invariant 5). */
  sendText?: boolean | undefined;
}

interface EndpointAcc {
  method: Method;
  route: string;
  operations: Map<string, OperationWork>;
}

export class ProfileAggregator {
  private endpoints = new Map<string, EndpointAcc>();
  private distinctRoutes = 0;
  private windowStart: number;
  private readonly now: () => number;
  private readonly maxRoutes: number;
  private readonly maxOperations: number;
  private readonly sendText: boolean;

  constructor(opts: ProfileOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxRoutes = opts.maxRoutes ?? DEFAULT_MAX_ROUTES;
    this.maxOperations = opts.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.sendText = opts.sendText ?? true;
    this.windowStart = this.now();
  }

  /** Folds one finished request's operations into the endpoint it belongs to. */
  record(method: Method, route: string, operations: Iterable<OperationWork>): void {
    let key = `${method} ${route}`;
    let acc = this.endpoints.get(key);
    if (!acc) {
      // Same cap and same bucket as the aggregates: an application with unbounded routes cannot grow this map.
      if (route !== OTHER_ROUTE && this.distinctRoutes >= this.maxRoutes) {
        route = OTHER_ROUTE;
        key = `${method} ${OTHER_ROUTE}`;
        acc = this.endpoints.get(key);
      } else if (route !== OTHER_ROUTE) {
        this.distinctRoutes += 1;
      }
      if (!acc) {
        acc = { method, route, operations: new Map() };
        this.endpoints.set(key, acc);
      }
    }
    for (const operation of operations) {
      const existing = acc.operations.get(operation.hash);
      if (existing) {
        existing.count += operation.count;
        existing.totalMs += operation.totalMs;
        existing.errors += operation.errors;
      } else {
        acc.operations.set(operation.hash, { ...operation });
      }
    }
  }

  /**
   * Closes the window and returns the profile, or null when the minute is not up or nothing happened in it.
   *
   * A quiet minute still resets the window: an empty profile says nothing the absence of one does not.
   */
  rotate(): Profile | null {
    const now = this.now();
    if (now - this.windowStart < PROFILE_WINDOW_MS) return null;
    return this.close(now);
  }

  /**
   * Closes the window whatever the clock says, for a process that is going away.
   *
   * A separate method and not a flag on `rotate`, because they answer different questions — «is it time?»
   * and «close it» — and a caller that could pass `true` on every interval would put the profile back on the
   * aggregates' cadence, which is the arithmetic the ADR 0017 says does not fit.
   *
   * Without this, a process that lives less than a minute sent no profile at all: `rotate` looked at the
   * clock, said no, and shutting down did not change the clock. The last incomplete minute of every process
   * went the same way (gh-371).
   */
  drain(): Profile | null {
    return this.close(this.now());
  }

  private close(now: number): Profile | null {
    const durationMs = now - this.windowStart;
    const accumulated = this.endpoints;
    const start = this.windowStart;
    this.endpoints = new Map();
    this.distinctRoutes = 0;
    this.windowStart = now;
    if (accumulated.size === 0) return null;
    return {
      start,
      durationMs,
      endpoints: [...accumulated.values()].map((acc) => this.endpointOf(acc)),
    };
  }

  private endpointOf(acc: EndpointAcc): ProfileEndpoint {
    // Most expensive first, by the time they actually took: a cap has to drop something, and what a route spends
    // its time on is what the person reading the profile came for.
    const sorted = [...acc.operations.values()].sort((a, b) => b.totalMs - a.totalMs);
    const kept = sorted.slice(0, this.maxOperations).map((work) => this.operationOf(work));
    const rest = sorted.slice(this.maxOperations);
    if (rest.length > 0) {
      // Everything the cap dropped still counts, and the bucket says how many it merges, so a cap does not
      // become a lie by omission (ADR 0017).
      kept.push({
        kind: "query",
        hash: OTHER_OPERATION,
        count: rest.reduce((a, w) => a + w.count, 0),
        totalMs: rest.reduce((a, w) => a + w.totalMs, 0),
        errors: rest.reduce((a, w) => a + w.errors, 0),
        distinct: rest.length,
      });
    }
    return { method: acc.method, route: acc.route, operations: kept };
  }

  private operationOf(work: OperationWork): Operation {
    const operation: Operation = {
      kind: work.kind,
      hash: work.hash,
      count: work.count,
      totalMs: work.totalMs,
      errors: work.errors,
    };
    if (!this.sendText) return operation;
    if (work.text !== "") operation.text = work.text;
    // Only when the user has not already answered the question. The absence of the text has one reason, and
    // when they turned it off that reason is theirs: the cloud must read `suppressed`, not `omitted`.
    else if (work.class !== undefined) operation.class = work.class;
    return operation;
  }
}
