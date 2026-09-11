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

/** The signal this fires on. One for now; the other two of `product.md:114` are their own tickets. */
export const EVENT_LOOP_DELAY = "event-loop-delay";

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
}

export class LocalTriggers {
  private readonly thresholdMs: number;
  private readonly sustained: number;
  private readonly cooldownMs: number;
  private over = 0;
  private askedAt: number | undefined;

  constructor(options: TriggerOptions = {}) {
    this.thresholdMs = options.thresholdMs ?? THRESHOLD_MS;
    this.sustained = options.sustainedIntervals ?? SUSTAINED_INTERVALS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
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
