import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { currentContext, recordOperationIn } from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";
import { OVERHEAD_BUDGET_MS, OverheadMeter, Sheddable, ThrottleReasons, WINDOW_REQUESTS } from "../src/overhead.ts";

/**
 * `product.md:241`: «si detecta que ella misma añade latencia, **se autolimita**». Two words carry it:
 * *detects* needs a measurement that did not exist, and *self-limits* needs somewhere to give ground that is
 * not the product itself (gh-271, ADR 0080).
 */

const quiet = { warn: () => {}, debug: () => {} };

/** The configuration every agent needs, with nothing instrumented: this is about the hooks, not the drivers. */
const config = () => ({
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
  instrument: new Set<never>(),
});

/** A meter whose clock a test can move, sampling every call so the arithmetic is visible. */
function meter(costPerHookMs: number, opts: { sampleEvery?: number; budgetMs?: number; window?: number } = {}) {
  let clock = 0;
  const m = new OverheadMeter({
    sampleEvery: opts.sampleEvery ?? 1,
    windowRequests: opts.window ?? WINDOW_REQUESTS,
    budgetMs: opts.budgetMs ?? OVERHEAD_BUDGET_MS,
    now: () => clock,
  });
  /** One hook that costs what the caller said. */
  const hook = () => {
    const started = m.enter();
    clock += costPerHookMs;
    m.leave(started);
  };
  return { m, hook, tick: (ms: number) => (clock += ms) };
}

describe("the meter", () => {
  it("times one hook in every period and leaves the rest alone", () => {
    let reads = 0;
    const m = new OverheadMeter({
      sampleEvery: 8,
      now: () => {
        reads += 1;
        return reads;
      },
    });
    for (let i = 0; i < 80; i += 1) m.leave(m.enter());
    // Ten of eighty timed, two clock reads each: the other seventy cost an increment and a comparison.
    expect(reads).toBe(20);
    expect(m.state().hooks).toBe(80);
  });

  it("says nothing until it has measured something", () => {
    const { m } = meter(1);
    expect(m.state().perRequestMs).toBe(0);
    expect(m.state().shed).toBe(Sheddable.Nothing);
  });

  /**
   * The sampled hooks stand for all of them: one in `every` is timed, so the total is what was measured
   * times the period. Without the extrapolation the estimate is off by that factor, and a meter that
   * under-reports by 64× never sheds anything.
   */
  it("extrapolates from the sample to the whole", () => {
    let clock = 0;
    const m = new OverheadMeter({
      sampleEvery: 8,
      windowRequests: 8,
      budgetMs: OVERHEAD_BUDGET_MS,
      now: () => clock,
    });
    // Eight requests, eight hooks each, every hook costing 0.1 ms. One in eight is timed, so eight of the
    // sixty-four are measured at 0.8 ms in total — and the truth is 6.4 ms, which is 0.8 per request.
    for (let r = 0; r < 8; r += 1) {
      for (let h = 0; h < 8; h += 1) {
        const started = m.enter();
        clock += 0.1;
        m.leave(started);
      }
      m.requestFinished();
    }
    expect(m.state().perRequestMs).toBeCloseTo(0.8, 6);
    expect(m.state().shed).toBe(Sheddable.Fine);
  });

  it("estimates per request, not in total: twice the traffic is not twice the cost", () => {
    const cheap = meter(0.001, { sampleEvery: 1 });
    for (let r = 0; r < WINDOW_REQUESTS * 2; r += 1) {
      cheap.hook();
      cheap.m.requestFinished();
    }
    // One cheap hook per request, so the estimate is that hook's cost however many requests there were.
    expect(cheap.m.state().perRequestMs).toBeCloseTo(0.001, 6);
    expect(cheap.m.state().shed).toBe(Sheddable.Nothing);
  });
});

describe("giving ground", () => {
  /** Runs a window of requests, each costing `hooks` hooks of `cost` ms. */
  function windows(m: ReturnType<typeof meter>, count: number, hooks: number) {
    for (let r = 0; r < count; r += 1) {
      for (let h = 0; h < hooks; h += 1) m.hook();
      m.m.requestFinished();
    }
  }

  it("sheds the fine detail first, and says why", () => {
    const m = meter(0.4, { sampleEvery: 1 });
    windows(m, WINDOW_REQUESTS, 2); // 0.8 ms per request, over the 0.5 budget

    const state = m.m.state();
    expect(state.perRequestMs).toBeGreaterThan(OVERHEAD_BUDGET_MS);
    expect(state.shed).toBe(Sheddable.Fine);
    expect(state.reason).toBe(ThrottleReasons.Latency);
    expect(m.m.keeping(Sheddable.Fine)).toBe(false);
    // The profile is still on: one level at a time.
    expect(m.m.keeping(Sheddable.Profile)).toBe(true);
  });

  it("sheds the profile next, and never the aggregate", () => {
    const m = meter(0.4, { sampleEvery: 1 });
    windows(m, WINDOW_REQUESTS * 3, 2);

    expect(m.m.state().shed).toBe(Sheddable.Profile);
    // There is no third level. Below the profile is the aggregate, which **is** the product: an
    // instrumentation that shed that would be alive and saying nothing (invariant 14 upside down).
    expect(Object.values(Sheddable).filter((v) => v > Sheddable.Profile)).toEqual([]);
  });

  it("does not take ground back at the same line it gave it up", () => {
    const m = meter(0.49, { sampleEvery: 1 });
    windows(m, WINDOW_REQUESTS, 2); // 0.98 ms: over the budget, sheds
    expect(m.m.state().shed).toBe(Sheddable.Fine);

    // 0.49 ms is under the budget and over half of it. Recovering here is what makes the level flap on a
    // burst, and detail that comes and goes is detail nobody can read.
    windows(m, WINDOW_REQUESTS, 1);
    expect(m.m.state().shed).toBe(Sheddable.Fine);
  });

  it("recovers a level once it is well under", () => {
    const m = meter(0.4, { sampleEvery: 1 });
    windows(m, WINDOW_REQUESTS, 2);
    expect(m.m.state().shed).toBe(Sheddable.Fine);

    // A window of hooks that cost nothing on this clock.
    for (let r = 0; r < WINDOW_REQUESTS; r += 1) {
      m.m.leave(m.m.enter());
      m.m.requestFinished();
    }
    expect(m.m.state().shed).toBe(Sheddable.Nothing);
    expect(m.m.state().reason).toBe("");
  });

  it("does not flap on a burst shorter than a window", () => {
    const m = meter(0.4, { sampleEvery: 1 });
    // Half a window of expensive requests: not enough to decide anything.
    for (let r = 0; r < WINDOW_REQUESTS / 2; r += 1) {
      m.hook();
      m.hook();
      m.m.requestFinished();
    }
    expect(m.m.state().shed).toBe(Sheddable.Nothing);
  });

  // The fourth promise of `product.md:241`, which shares the machinery: «si se acerca a su presupuesto de
  // memoria, reduce la ventana de detalle y **lo registra como pérdida de cobertura**».
  it("gives up the detail for memory too, with its own reason", () => {
    const { m } = meter(0.001);
    m.shedForMemory();
    expect(m.state().shed).toBe(Sheddable.Fine);
    expect(m.state().reason).toBe(ThrottleReasons.Memory);
  });
});

describe("the agent", () => {
  it("reports what it has given up and what it estimates it costs", () => {
    const agent = createAgent(config(), { log: quiet });
    const stats = agent.stats;
    expect(stats.shed).toBe(Sheddable.Nothing);
    expect(stats.shedReason).toBe("");
    expect(stats.overheadPerRequestMs).toBe(0);
  });

  /**
   * Shedding has to stop the **writes**, not just the reads. An agent that went on filling the ring and
   * declined to publish it would go on costing exactly what it costs, which is the opposite of a
   * self-limit. The register reaches an operation through the request's context, so what has to stop is
   * being handed over at all.
   */
  it("stops handing the register to a request once the detail has been shed", () => {
    const overhead = new OverheadMeter({ sampleEvery: 1, windowRequests: 2, budgetMs: 0 });
    const fine = new FineRegister();
    const agent = createAgent(
      { ...config(), instrument: new Set(["http"] as const) },
      {
        log: quiet,
        overhead,
        fine,
      },
    );
    agent.start();
    try {
      const start = channel("http.server.request.start");
      const finish = channel("http.server.response.finish");
      const wrote: boolean[] = [];
      for (let i = 0; i < 6; i += 1) {
        const request = { method: "GET", url: "/checkout" };
        start.publish({ request });
        const ctx = currentContext();
        // One operation per request, the way an instrumented query would.
        if (ctx) {
          recordOperationIn(ctx, {
            kind: "query",
            fingerprint: { hash: `h${i}`, text: "SELECT 1" },
            startedAt: 0,
            endedAt: 1,
          });
          wrote.push(ctx.fine !== undefined);
        }
        finish.publish({ request, response: { statusCode: 200 } });
      }
      expect(wrote[0]).toBe(true);
      expect(wrote.at(-1)).toBe(false);
    } finally {
      void agent.stop();
    }
  });

  it("stops writing the fine detail once it has been shed, not just reading it", () => {
    // Sampling every call and a budget of zero: the first closed window sheds.
    // Sampling every call, a window of two requests and a budget of zero: it sheds as soon as it can.
    const overhead = new OverheadMeter({ sampleEvery: 1, windowRequests: 2, budgetMs: 0 });
    const fine = new FineRegister();
    const agent = createAgent(config(), { log: quiet, overhead, fine });
    agent.start();
    try {
      const start = channel("http.server.request.start");
      const finish = channel("http.server.response.finish");
      for (let i = 0; i < 8; i += 1) {
        const request = { method: "GET", url: "/checkout" };
        start.publish({ request });
        finish.publish({ request, response: { statusCode: 200 } });
      }
      const stats = agent.stats;
      expect(stats.shed).toBeGreaterThanOrEqual(Sheddable.Fine);
      expect(stats.shedReason).toBe(ThrottleReasons.Latency);
      // The requests are still counted: what was given up is the detail, never the aggregate.
      expect(stats.recorded).toBe(8);
      // And the writing stopped, not just the reading: the register holds the ones from before it shed and
      // no more. Shedding that only stopped the reads would go on costing exactly what it costs.
      const held = fine.snapshot().coverage.requests;
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(8);
    } finally {
      void agent.stop();
    }
  });
});
