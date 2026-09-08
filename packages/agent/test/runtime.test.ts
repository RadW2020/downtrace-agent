import type { RuntimeHealth } from "@downtrace/protocol";
import { describe, expect, it } from "vitest";
import { RuntimeSampler } from "../src/runtime.ts";

/** Keeps the event loop busy long enough for the delay histogram to have something to say. */
function block(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy on purpose
  }
}

/**
 * Returns one window the delay histogram actually has something to say about.
 *
 * `monitorEventLoopDelay` samples on a timer of its own. On a machine that is starving this process — a CI runner
 * at Nice=10 with the 22-minute benchmark next door — that timer can fail to fire inside any given window, and the
 * histogram comes back empty. Asserting on the first window assumed the sampling had happened, and failed for the
 * opposite of the obvious reason: not because the loop never lagged, but because nobody got to measure it (gh-160).
 *
 * Waiting is not the same as retrying until green: an empty window is not a result being discarded, it is the
 * measurement not having started. The attempt cap keeps a sampler that genuinely records nothing a failure.
 */
async function windowWithDelay(sampler: RuntimeSampler, attempts = 40): Promise<RuntimeHealth> {
  for (let i = 0; i < attempts; i++) {
    block(30);
    await new Promise((r) => setTimeout(r, 40));
    const health = sampler.rotate();
    if (health && health.eventLoopDelayMs.max > 0) return health;
  }
  throw new Error(`the event loop delay histogram recorded nothing across ${attempts} windows`);
}

describe("RuntimeSampler", () => {
  it("reports nothing before it is started", () => {
    const sampler = new RuntimeSampler();
    expect(sampler.started).toBe(false);
    expect(sampler.rotate()).toBeUndefined();
  });

  it("measures the process and fills every field the protocol requires", async () => {
    const sampler = new RuntimeSampler();
    sampler.start();
    const health = await windowWithDelay(sampler);
    sampler.stop();

    expect(Object.keys(health).sort()).toEqual(
      ["eventLoopDelayMs", "gcCount", "gcPauseMs", "heapUsedMb", "inFlightMax", "rssMb"].sort(),
    );
    expect(health.eventLoopDelayMs.max).toBeGreaterThan(0);
    expect(health.eventLoopDelayMs.p99).toBeGreaterThanOrEqual(health.eventLoopDelayMs.p50);
    expect(health.rssMb).toBeGreaterThan(0);
    expect(health.heapUsedMb).toBeGreaterThan(0);
    expect(health.gcCount).toBeGreaterThanOrEqual(0);
  });

  it("tracks the peak of concurrent requests, not the current count", () => {
    const sampler = new RuntimeSampler();
    sampler.start();
    for (let i = 0; i < 5; i++) sampler.requestStarted();
    for (let i = 0; i < 4; i++) sampler.requestFinished();
    const health = sampler.rotate();
    sampler.stop();
    expect(health?.inFlightMax).toBe(5);
  });

  it("starts the next window from what is still in flight, not from zero", () => {
    const sampler = new RuntimeSampler();
    sampler.start();
    sampler.requestStarted();
    sampler.requestStarted();
    sampler.rotate(); // two still in flight
    const health = sampler.rotate();
    sampler.stop();
    expect(health?.inFlightMax).toBe(2);
  });

  it("never counts below zero, however the events arrive", () => {
    const sampler = new RuntimeSampler();
    sampler.start();
    sampler.requestFinished(); // a response whose start we never saw
    sampler.requestStarted();
    const health = sampler.rotate();
    sampler.stop();
    expect(health?.inFlightMax).toBe(1);
  });

  it("resets its counters between windows", async () => {
    const sampler = new RuntimeSampler();
    sampler.start();
    const first = await windowWithDelay(sampler);
    // Rotating again immediately: no sampling interval has elapsed, so a histogram that was reset reports nothing.
    // Comparing magnitudes between windows instead would measure the machine, and a loaded runner fails it.
    const second = sampler.rotate();
    sampler.stop();
    expect(first.eventLoopDelayMs.max).toBeGreaterThan(0);
    expect(second?.eventLoopDelayMs.max).toBe(0);
    expect(second?.gcCount).toBe(0);
    expect(second?.gcPauseMs).toBe(0);
  });

  it("can be started twice without doubling its instruments", () => {
    const sampler = new RuntimeSampler();
    sampler.start();
    sampler.start();
    expect(sampler.started).toBe(true);
    sampler.stop();
    expect(sampler.started).toBe(false);
  });
});
