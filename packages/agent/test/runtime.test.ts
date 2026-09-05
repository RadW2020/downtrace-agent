import { describe, expect, it } from "vitest";
import { RuntimeSampler } from "../src/runtime.ts";

/** Keeps the event loop busy long enough for the delay histogram to have something to say. */
function block(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy on purpose
  }
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
    block(30);
    await new Promise((r) => setTimeout(r, 40)); // let the loop sample itself
    const health = sampler.rotate();
    sampler.stop();

    expect(health).toBeDefined();
    if (!health) return;
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
    block(30);
    await new Promise((r) => setTimeout(r, 20));
    const first = sampler.rotate();
    // Rotating again immediately: no sampling interval has elapsed, so a histogram that was reset reports nothing.
    // Comparing magnitudes between windows instead would measure the machine, and a loaded runner fails it.
    const second = sampler.rotate();
    sampler.stop();
    expect(first?.eventLoopDelayMs.max).toBeGreaterThan(0);
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
