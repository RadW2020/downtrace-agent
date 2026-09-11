import { describe, expect, it } from "vitest";
import { EVENT_LOOP_DELAY, LocalTriggers, SUSTAINED_INTERVALS, THRESHOLD_MS } from "../src/trigger.ts";

/**
 * The local signal that asks for a capture. `product.md:124` gives this to the instrumentation —«disparar
 * por señales locales»— and `product.md:114` says what kind of signal it is: an absolute threshold,
 * **sustained**, not a spike.
 */

const health = (p99: number) => ({ eventLoopDelayMs: { p50: 1, p99, max: p99 } });

describe("the local trigger", () => {
  it("says nothing while the loop is healthy", () => {
    const t = new LocalTriggers();
    for (let i = 0; i < 10; i += 1) expect(t.interval(health(3), 1_000 + i)).toBeUndefined();
  });

  it("does not fire on one bad interval, which is what a spike looks like", () => {
    const t = new LocalTriggers();
    expect(t.interval(health(THRESHOLD_MS + 50), 1_000)).toBeUndefined();
  });

  it("fires once the signal has stayed over its threshold, and says what it measured", () => {
    const t = new LocalTriggers();
    let fired: ReturnType<LocalTriggers["interval"]>;
    for (let i = 0; i < SUSTAINED_INTERVALS; i += 1) fired = t.interval(health(THRESHOLD_MS + 50), 1_000 + i);

    expect(fired?.signal).toBe(EVENT_LOOP_DELAY);
    expect(fired?.valueMs).toBe(THRESHOLD_MS + 50);
    // The threshold travels with the value: a number nobody can compare against anything says nothing.
    expect(fired?.thresholdMs).toBe(THRESHOLD_MS);
    expect(fired?.intervals).toBe(SUSTAINED_INTERVALS);
  });

  it("a good interval in between starts the count again", () => {
    const t = new LocalTriggers();
    for (let i = 0; i < SUSTAINED_INTERVALS - 1; i += 1) t.interval(health(THRESHOLD_MS + 50), 1_000 + i);
    t.interval(health(1), 2_000);
    expect(t.interval(health(THRESHOLD_MS + 50), 3_000)).toBeUndefined();
  });

  it("does not ask again while it is cooling down, however long the signal lasts", () => {
    // «Tras una captura hay un periodo de enfriamiento para la misma huella» (`product.md:122`). Here it
    // is local, because a signal that lasts ten minutes would otherwise ask on every interval.
    const t = new LocalTriggers();
    let asks = 0;
    // Sixty intervals of ten seconds is ten minutes of a loop that never recovers. With a cooldown of
    // five it asks twice, not sixty times.
    for (let i = 0; i < 60; i += 1) {
      if (t.interval(health(THRESHOLD_MS + 50), 1_000 + i * 10_000) !== undefined) asks += 1;
    }
    expect(asks).toBe(2);
  });

  it("asks again once the cooldown has passed", () => {
    const t = new LocalTriggers({ cooldownMs: 30_000 });
    let asks = 0;
    for (let i = 0; i < 20; i += 1) {
      if (t.interval(health(THRESHOLD_MS + 50), 1_000 + i * 10_000) !== undefined) asks += 1;
    }
    expect(asks).toBeGreaterThan(1);
  });

  it("says nothing when there is no runtime health to read", () => {
    // The runtime observer can be off (`DOWNTRACE_INSTRUMENT`), and a signal nobody is measuring is not a
    // signal that is fine: it is one nobody is looking at (invariant 14).
    const t = new LocalTriggers();
    for (let i = 0; i < 10; i += 1) expect(t.interval(undefined, 1_000 + i)).toBeUndefined();
  });

  it("reads a health that has no event loop at all without inventing one", () => {
    // `RuntimeHealth` requires none of its fields since 0.7.0: a Go runtime has no event loop.
    const t = new LocalTriggers();
    for (let i = 0; i < 10; i += 1) expect(t.interval({ rssMb: 100 }, 1_000 + i)).toBeUndefined();
  });
});
