import { describe, expect, it } from "vitest";
import { newCounters, recordPoolWait, Stats } from "../src/stats.ts";

/**
 * The benchmark's rounds collapse when the connection pool starves, and the total wait over sixty seconds is too
 * coarse to line up with anything (gh-177). What the round needs is the worst single wait and when it happened.
 */
describe("the worst single pool wait", () => {
  it("is one wait, not the sum of a request's waits", () => {
    const ctx = newCounters();
    for (const ms of [10, 10, 10]) recordPoolWait(ctx, ms, 1_000);
    expect(ctx.poolWaitMs).toBe(30);
    expect(ctx.maxPoolWaitMs).toBe(10);
  });

  it("keeps the worst across requests, with its instant", () => {
    const stats = new Stats();
    const first = newCounters();
    recordPoolWait(first, 5, 1_000);
    stats.record("GET /a", 200, 1, first);

    const second = newCounters();
    recordPoolWait(second, 40, 2_000);
    stats.record("GET /a", 200, 1, second);

    const snapshot = stats.snapshot()["GET /a"];
    expect(snapshot?.maxPoolWaitMs).toBe(40);
    expect(snapshot?.maxPoolWaitAt).toBe(2_000);
  });

  it("does not let a later, shorter wait overwrite the worst one", () => {
    const stats = new Stats();
    const worst = newCounters();
    recordPoolWait(worst, 40, 2_000);
    stats.record("GET /a", 200, 1, worst);

    const later = newCounters();
    recordPoolWait(later, 5, 9_000);
    stats.record("GET /a", 200, 1, later);

    const snapshot = stats.snapshot()["GET /a"];
    expect(snapshot?.maxPoolWaitMs).toBe(40);
    expect(snapshot?.maxPoolWaitAt).toBe(2_000);
  });

  it("has no instant when nothing ever waited", () => {
    const stats = new Stats();
    stats.record("GET /a", 200, 1, newCounters());
    const snapshot = stats.snapshot()["GET /a"];
    expect(snapshot?.maxPoolWaitMs).toBe(0);
    expect(snapshot?.maxPoolWaitAt).toBeUndefined();
  });

  it("forgets both when the round resets the statistics", () => {
    const stats = new Stats();
    const ctx = newCounters();
    recordPoolWait(ctx, 40, 2_000);
    stats.record("GET /a", 200, 1, ctx);
    stats.reset();
    stats.record("GET /a", 200, 1, newCounters());
    const snapshot = stats.snapshot()["GET /a"];
    expect(snapshot?.maxPoolWaitMs).toBe(0);
    expect(snapshot?.maxPoolWaitAt).toBeUndefined();
  });
});
