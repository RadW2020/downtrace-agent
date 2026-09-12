/**
 * The local signals that ask for a capture.
 *
 * `product.md:124` splits the work: the instrumentation «dispara por señales locales», the cloud does
 * what needs to see the whole fleet. This is the first half — a process whose event loop is running late
 * knows it long before any aggregate crosses the network, and by the time the cloud could notice, the
 * detail that would explain it has been overwritten.
 *
 * What it does **not** do is decide there is an incident. It asks for detail; the cloud decides, against
 * the same budget, cooldown and concurrency as any other capture (`product.md:122`). A refusal is
 * silence, because there is nothing this side would do differently.
 *
 * The shape of the rule comes from `product.md:114`: «Los que usan umbrales absolutos pueden evaluar
 * desde las primeras observaciones suficientes: timeouts de una dependencia, espera de pool o retraso
 * del event loop **sostenidos** por encima del umbral».
 */

import type { LocalTrigger, RuntimeHealth } from "@downtrace/protocol";

/** The signal this asks for a capture on. Dependency timeouts, the third of `product.md:114`, is its own ticket. */
export const EVENT_LOOP_DELAY = "event-loop-delay";

/**
 * How long a route's requests may spend, on average, waiting for a connection before the route is armed.
 *
 * A healthy pool hands one over at once, so fifty milliseconds per request means they are queueing for real.
 * Conservative on purpose, like the event loop's quarter of a second: arming costs memory that other routes
 * could have used, and a threshold that fires on a busy minute would spend it on nothing.
 */
export const POOL_WAIT_MS_PER_REQUEST = 50;

/**
 * Requests an endpoint needs in the interval before its average means anything. One request that queued for
 * four seconds on a quiet route is one request, not a route in trouble — and the average would not say so.
 */
export const MIN_REQUESTS_TO_ARM = 20;

/** How long an arm lasts. Long enough to hold the start of an incident, short enough to bound four of them. */
export const ARM_FOR_MS = 2 * 60_000;

/**
 * How late the event loop has to run, at the p99 of an interval, to count.
 *
 * A quarter of a second is conservative on purpose: a healthy Node process sits in single-digit
 * milliseconds, and a process 250 ms late at the p99 is one where a request that arrives has to wait
 * that long before anything happens to it. Asking for detail costs the budget, and a threshold that
 * fires on a busy minute would spend it on nothing.
 */
export const THRESHOLD_MS = 250;

/** How many intervals in a row it has to stay over. More than one is what makes it sustained. */
export const SUSTAINED_INTERVALS = 2;

/** How long before the same signal may ask again. */
export const DEFAULT_COOLDOWN_MS = 5 * 60_000;

export interface TriggerOptions {
  thresholdMs?: number;
  sustainedIntervals?: number;
  cooldownMs?: number;
  poolWaitMsPerRequest?: number;
  minRequestsToArm?: number;
}

/** What the aggregator's interval says about one endpoint, of which this reads two things. */
interface IntervalEndpoint {
  method: string;
  route: string;
  count: number;
  dependencies?: { waitMs?: number }[];
}

interface IntervalLike {
  endpoints: IntervalEndpoint[];
}

export class LocalTriggers {
  private readonly thresholdMs: number;
  private readonly sustained: number;
  private readonly cooldownMs: number;
  private readonly poolWaitPerRequest: number;
  private readonly minRequests: number;
  private over = 0;
  private askedAt: number | undefined;
  /** How many intervals in a row each route has been over its threshold. Cleared when one comes back clean. */
  private readonly queueing = new Map<string, number>();

  constructor(options: TriggerOptions = {}) {
    this.thresholdMs = options.thresholdMs ?? THRESHOLD_MS;
    this.sustained = options.sustainedIntervals ?? SUSTAINED_INTERVALS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.poolWaitPerRequest = options.poolWaitMsPerRequest ?? POOL_WAIT_MS_PER_REQUEST;
    this.minRequests = options.minRequestsToArm ?? MIN_REQUESTS_TO_ARM;
  }

  /**
   * The routes whose requests keep queueing for a connection, which are the ones worth arming.
   *
   * Read from the interval the aggregator already built — each endpoint carries its request count and its
   * dependencies, and each dependency the wait it accumulated — so this costs nothing on the hot path: it
   * looks once per interval at a structure that exists either way.
   *
   * Only pool wait. It is the one signal of `product.md:114` measured per request and therefore already
   * attributed to the route that caused it; the event loop and requests in flight belong to the process, and
   * naming the busiest route would attribute a problem nobody measured (ATR-01, ADR 0112, ADR 0122).
   *
   * Arming is silent: this returns labels to arm and asks the cloud for nothing.
   */
  endpoints(interval: IntervalLike, _now: number): string[] {
    const armed: string[] = [];
    const seen = new Set<string>();
    for (const e of interval.endpoints) {
      const label = `${e.method} ${e.route}`;
      seen.add(label);
      // Absent is not zero, but here both answers arrive at the same place and only one of them is a rule:
      // a route whose dependencies report no wait has nothing measured to arm on, and a route that waited
      // nothing has nothing to arm on either. An earlier version carried a flag to tell them apart and it
      // changed no outcome, so it is gone rather than left looking like it protects something.
      let wait = 0;
      for (const d of e.dependencies ?? []) wait += d.waitMs ?? 0;
      if (e.count < this.minRequests || wait / e.count <= this.poolWaitPerRequest) {
        // A good interval breaks the run, for the same reason it does for the event loop: what a threshold
        // is for is a signal that stays.
        this.queueing.delete(label);
        continue;
      }
      const over = (this.queueing.get(label) ?? 0) + 1;
      this.queueing.set(label, over);
      if (over >= this.sustained) armed.push(label);
    }
    // A route that stopped appearing is a route that stopped serving: its run does not survive the silence.
    for (const label of [...this.queueing.keys()]) if (!seen.has(label)) this.queueing.delete(label);
    return armed;
  }

  /**
   * One interval's worth of runtime health. Returns what to ask for, or nothing.
   *
   * `health` is optional and its fields are too: the runtime observer can be off, and a signal nobody
   * measures is not a signal that is fine (invariant 14). Neither case fires.
   */
  interval(health: RuntimeHealth | undefined, now: number): LocalTrigger | undefined {
    const p99 = health?.eventLoopDelayMs?.p99;
    if (p99 === undefined) {
      this.over = 0;
      return undefined;
    }
    if (p99 <= this.thresholdMs) {
      // A good interval breaks the run: what the threshold is for is a signal that stays, and a spike
      // between two quiet intervals is not one.
      this.over = 0;
      return undefined;
    }
    this.over += 1;
    if (this.over < this.sustained) return undefined;
    if (this.askedAt !== undefined && now - this.askedAt < this.cooldownMs) return undefined;
    this.askedAt = now;
    return {
      signal: EVENT_LOOP_DELAY,
      observedAt: now,
      valueMs: p99,
      thresholdMs: this.thresholdMs,
      intervals: this.over,
    };
  }
}
