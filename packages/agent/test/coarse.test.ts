import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { COARSE_MAX_BYTES, CoarseRegister, DEFAULT_ROUTES, DEFAULT_SECONDS } from "../src/coarse.ts";
import { OTHER_ROUTE } from "../src/routes.ts";

/** A logger that says nothing: this test is about the register, not about what the agent prints. */
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * The coarse half of the black box. Nothing here leaves the process yet; what these tests protect is that the
 * memory is bounded by construction (invariant 1) and that a quiet second is not confused with an unwatched one
 * (invariant 14).
 */

/** A clock a test drives by hand, in seconds. */
function clock(startSecond = 1_000_000) {
  let second = startSecond;
  return {
    now: () => second * 1000,
    tick: (by = 1) => {
      second += by;
    },
    at: () => second,
  };
}

describe("the coarse register", () => {
  it("keeps one slot per second", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 10 });

    r.record("GET", "/orders", 200, 10, 2);
    c.tick();
    r.record("GET", "/orders", 200, 20, 3);
    r.record("GET", "/orders", 500, 30, 1);
    c.tick();
    r.record("GET", "/orders", 200, 40, 0);

    const [route] = r.snapshot().routes;
    expect(route?.seconds).toHaveLength(3);
    expect(route?.seconds.map((s) => s.requests)).toEqual([1, 2, 1]);
    expect(route?.seconds[1]?.errors).toBe(1);
    expect(route?.seconds[1]?.latencySumMs).toBe(50);
    expect(route?.seconds[1]?.latencyMaxMs).toBe(30);
    expect(route?.seconds[1]?.calls).toBe(4);
  });

  it("overwrites the oldest second, not the newest", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 3 });

    for (let i = 0; i < 5; i += 1) {
      if (i > 0) c.tick();
      r.record("GET", "/orders", 200, i, 0);
    }
    // Five seconds of traffic through a three-second window: the last three survive, and the first two are gone
    // rather than the last two.
    const [route] = r.snapshot().routes;
    expect(route?.seconds).toHaveLength(3);
    expect(route?.seconds.map((s) => s.latencyMaxMs)).toEqual([2, 3, 4]);
    // And the slot a wrapped second lands on is **cleared**, not added to: one request each, never two.
    expect(route?.seconds.map((s) => s.requests)).toEqual([1, 1, 1]);
  });

  it("does not grow with traffic", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 5 });

    for (let i = 0; i < 500; i += 1) {
      r.record("GET", "/orders", 200, 1, 1);
      if (i % 3 === 0) c.tick();
    }
    const snapshot = r.snapshot();
    expect(snapshot.routes).toHaveLength(1);
    // The window never holds more than its own length, whatever happened inside it.
    expect(snapshot.routes[0]?.seconds.length).toBeLessThanOrEqual(5);
  });

  // Invariant 14, in the register: a route that went silent for thirty seconds is how a great many incidents
  // look, and it must not read the same as a route nobody was watching.
  it("tells a quiet second from an unwatched one", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 10 });

    r.record("GET", "/orders", 200, 10, 0);
    c.tick(4);
    r.record("GET", "/orders", 200, 10, 0);

    const [route] = r.snapshot().routes;
    // Five seconds: the two with traffic and the three of silence between them, as zeros.
    expect(route?.seconds).toHaveLength(5);
    expect(route?.seconds.map((s) => s.requests)).toEqual([1, 0, 0, 0, 1]);
  });

  it("says nothing about the seconds before it first saw a route", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 10 });

    c.tick(20); // the register has existed for a while with nothing on this route
    r.record("GET", "/orders", 200, 10, 0);

    const [route] = r.snapshot().routes;
    // One second, not ten of invented silence: nobody was watching this route before it appeared.
    expect(route?.seconds).toHaveLength(1);
  });

  it("folds the routes that do not fit and counts them once each", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 5, maxRoutes: 2 });

    r.record("GET", "/a", 200, 1, 0);
    r.record("GET", "/b", 200, 1, 0);
    r.record("GET", "/c", 200, 1, 0);
    r.record("GET", "/c", 200, 1, 0); // the same dropped route again
    r.record("GET", "/d", 200, 1, 0);

    const snapshot = r.snapshot();
    expect(snapshot.coverage.routesDropped).toBe(2);
    expect(snapshot.routes.map((x) => x.route)).toContain(OTHER_ROUTE);
    const other = snapshot.routes.find((x) => x.route === OTHER_ROUTE);
    expect(other?.seconds[0]?.requests).toBe(3);
  });

  it("reports its coverage", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 42, maxRoutes: 2 });
    r.record("GET", "/a", 200, 1, 0);

    const coverage = r.snapshot().coverage;
    expect(coverage.windowSeconds).toBe(42);
    expect(coverage.routes).toBe(1);
    expect(coverage.routesDropped).toBe(0);
  });

  // The delay belongs to the process. Attributing it to a route would be inventing a measurement.
  it("keeps the event loop delay out of the routes", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 10 });

    r.record("GET", "/orders", 200, 10, 0);
    r.recordEventLoop(4);
    r.recordEventLoop(19); // the worst reading of a second wins: a second that stalled, stalled
    r.recordEventLoop(7);
    c.tick();
    r.recordEventLoop(2);

    const snapshot = r.snapshot();
    expect(snapshot.eventLoop.map((s) => s.maxDelayMs)).toEqual([19, 2]);
    expect(JSON.stringify(snapshot.routes)).not.toContain("19");
  });

  it("reports no event loop reading for a second nobody sampled", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 10 });

    r.recordEventLoop(3);
    c.tick(2);
    r.recordEventLoop(5);

    // Two readings, not four: a second with no sample says nothing about the loop, and a zero would say it was
    // idle.
    expect(r.snapshot().eventLoop).toHaveLength(2);
  });

  // The memory half of invariant 3. The latency and CPU halves are what `make bench` measures; this one is
  // arithmetic, and arithmetic can be asserted here rather than hoped for.
  it("stays inside its memory budget at its worst", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now });
    for (let i = 0; i < DEFAULT_ROUTES * 2; i += 1) r.record("GET", `/route-${i}`, 200, 1, 0);

    expect(r.snapshot().coverage.routes).toBeLessThanOrEqual(DEFAULT_ROUTES + 1);
    expect(r.bytes()).toBeLessThanOrEqual(COARSE_MAX_BYTES);
    // And the budget is not passing because the register is tiny: it really holds five minutes of every row.
    expect(DEFAULT_SECONDS).toBeGreaterThanOrEqual(300);
    expect(r.bytes()).toBeGreaterThan(1024 * 1024);
  });

  it("allocates one row per route and no more", () => {
    const c = clock();
    const r = new CoarseRegister({ now: c.now, seconds: 5 });

    for (let i = 0; i < 100; i += 1) {
      r.record("GET", "/orders", 200, 1, 1);
      r.record("POST", "/orders", 200, 1, 1);
      c.tick();
    }
    expect(r.snapshot().routes).toHaveLength(2);
  });
});

describe("the agent's coarse register", () => {
  it("records a finished request into it", async () => {
    const c = clock();
    const coarse = new CoarseRegister({ now: c.now, seconds: 10 });
    const agent = createAgent(
      {
        token: "test-token",
        url: "http://127.0.0.1:1/x",
        environment: "test",
        version: "t1",
        queryText: true,
        minimal: false,
        excludeEndpoints: [],
        excludeDependencies: [],
        inspect: undefined,
        debug: false,
        intervalMs: 60_000,
        instrument: new Set(),
      },
      { coarse, log: silent },
    );
    agent.start();
    try {
      // The same message shape the diagnostics channel publishes.
      const request = { method: "GET", url: "/orders" };
      channel("http.server.request.start").publish({ request });
      channel("http.server.response.finish").publish({ request, response: { statusCode: 500 } });
    } finally {
      await agent.stop();
    }

    const [route] = coarse.snapshot().routes;
    expect(route?.method).toBe("GET");
    expect(route?.seconds.at(-1)?.requests).toBe(1);
    expect(route?.seconds.at(-1)?.errors).toBe(1);
  });
});
