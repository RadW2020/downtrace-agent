import type { Operation, Profile, ProfileEndpoint } from "@downtrace/protocol";
import { DEFAULT_MAX_ROUTES } from "./aggregator.ts";
import { type OperationWork, operationKey } from "./context.ts";
import { type Method, OTHER_ROUTE } from "./routes.ts";

/**
 * What each route normally does, as opposed to how it performed.
 *
 * A profile changes when the code changes, so it goes out once a minute rather than with every interval: at the
 * aggregates' cadence it would repeat itself six times a minute and would not fit in the project's row budget
 * (ADR 0017, invariant 8).
 */

/**
 * One minute, the cadence the ADR fixed, and the default a process runs on. `DOWNTRACE_PROFILE_MS` can shorten
 * it for a process that has to be observed in less time than that; the number here is what production uses and
 * ADR 0017 still holds it (gh-565).
 */
export const PROFILE_WINDOW_MS = 60_000;

/** Fingerprints kept per endpoint. Plus the bucket, this is the schema's `maxItems: 64`. */
export const DEFAULT_MAX_OPERATIONS = 63;

/** The bucket that holds everything past the cap. */
export const OTHER_OPERATION = "(other)";

/**
 * What survives the per-endpoint cap first. An error outranks a query, and the three kinds of error rank
 * alike: telling them apart here would be a claim about which way of seeing an error matters more, and
 * nothing has measured one.
 */
function rank(kind: OperationWork["kind"]): number {
  return kind === "query" ? 0 : 1;
}

export interface ProfileOptions {
  /**
   * The agent's clock (`AgentDeps.now`). Required: this defaulted to `Date.now`, which the agent never
   * overrode, so every profile window was dated with a clock nothing else in the agent used (gh-610, ADR 0126).
   */
  now: () => number;
  /** How long a window stays open. `PROFILE_WINDOW_MS` unless the operator shortened it (gh-565). */
  windowMs?: number | undefined;
  maxRoutes?: number | undefined;
  maxOperations?: number | undefined;
  /** Off suppresses the normalised text and nothing else: the hash is the identity (invariant 5). */
  sendText?: boolean | undefined;
  /**
   * Off withholds the context an application attached to an error it reported (ERR-02).
   *
   * A switch of its own and not `sendText`, because the two answer different questions:
   * `DOWNTRACE_QUERY_TEXT=off` is «send my routes but not my queries», and a context is neither a route nor a
   * query. What turns this one off is the minimal mode, which withholds every free text there is (ADR 0105).
   */
  sendContext?: boolean | undefined;
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
  private readonly sendContext: boolean;
  private readonly windowMs: number;

  constructor(opts: ProfileOptions) {
    this.now = opts.now;
    this.windowMs = opts.windowMs && opts.windowMs > 0 ? opts.windowMs : PROFILE_WINDOW_MS;
    this.maxRoutes = opts.maxRoutes ?? DEFAULT_MAX_ROUTES;
    this.maxOperations = opts.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.sendText = opts.sendText ?? true;
    this.sendContext = opts.sendContext ?? true;
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
      const key = operationKey(operation.kind, operation.hash);
      const existing = acc.operations.get(key);
      if (existing) {
        existing.count += operation.count;
        existing.totalMs += operation.totalMs;
        existing.errors += operation.errors;
        // The first context this window saw for this signature stays, as it does inside one request: the
        // window counts occurrences and does not date them, so a later one would be an arbitrary swap.
        existing.context ??= operation.context;
      } else {
        acc.operations.set(key, { ...operation });
      }
    }
  }

  /**
   * Closes the window and returns the profile, or null when the window is not up or nothing happened in it.
   *
   * A quiet minute still resets the window: an empty profile says nothing the absence of one does not.
   */
  rotate(): Profile | null {
    const now = this.now();
    if (now - this.windowStart < this.windowMs) return null;
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
    const accumulated = this.endpoints;
    const start = this.windowStart;
    this.endpoints = new Map();
    this.distinctRoutes = 0;
    this.windowStart = now;
    if (accumulated.size === 0) return null;
    return {
      // Rounded here, where the window becomes what the batch carries, and nowhere before: the contract's
      // instants are integers and the agent's clock is not, while `rotate` has to decide with the instant the
      // window really started at (ADR 0145, gh-610). Down, and the duration as the interval's, so the two
      // windows of one batch are written the same way.
      start: Math.floor(start),
      // At least one: the contract says `durationMs >= 1`, and a process that observes something and leaves
      // within the same millisecond would otherwise send a batch the cloud refuses with a 400 — losing the
      // aggregates too, and opening a coverage-loss episode for what is a rounding error (gh-392). The
      // window existed and had operations in it; «shorter than can be measured» is truer than nothing.
      durationMs: Math.max(1, Math.round(now - start)),
      endpoints: [...accumulated.values()].map((acc) => this.endpointOf(acc)),
    };
  }

  private endpointOf(acc: EndpointAcc): ProfileEndpoint {
    // Errors first, then the most expensive by the time they actually took: a cap has to drop something, and
    // what a route spends its time on is what the person reading the profile came for — but an error is not
    // there to be read, it is an identity nothing else carries (ERR-01). An error the application reported
    // takes no time at all, so ordering by time alone would make it the first thing merged into a bucket the
    // protocol labels a query, on every route with more than sixty-three distinct operations. The hash breaks
    // the remaining ties, so two windows with the same operations cut at the same place.
    const sorted = [...acc.operations.values()].sort((a, b) => {
      const kinds = rank(b.kind) - rank(a.kind);
      if (kinds !== 0) return kinds;
      if (b.totalMs !== a.totalMs) return b.totalMs - a.totalMs;
      return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
    });
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
    // The context is governed by the minimal mode and by nothing else, so it is decided before the text: a
    // user who turned off the text of their queries did not ask for this to go with it.
    if (this.sendContext && work.context !== undefined) operation.context = work.context;
    if (!this.sendText) return operation;
    if (work.text !== "") operation.text = work.text;
    // Only when the user has not already answered the question. The absence of the text has one reason, and
    // when they turned it off that reason is theirs: the cloud must read `suppressed`, not `omitted`.
    else if (work.class !== undefined) operation.class = work.class;
    return operation;
  }
}
