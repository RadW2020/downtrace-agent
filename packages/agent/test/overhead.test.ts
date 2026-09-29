import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { COARSE_MAX_BYTES, CoarseRegister } from "../src/coarse.ts";
import { currentContext, recordCall, recordOperationIn } from "../src/context.ts";
import { FINE_MAX_BYTES, FineRegister } from "../src/fine.ts";
import { OVERHEAD_BUDGET_MS, OverheadMeter, Sheddable, ThrottleReasons, WINDOW_REQUESTS } from "../src/overhead.ts";
import { PREARM_MAX_BYTES, PrearmRegister } from "../src/prearm.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * `product.md:241`: «if it detects that it is itself adding latency, it throttles itself». Two words carry it:
 * *detects* needs a measurement that did not exist, and *self-limits* needs somewhere to give ground that is
 * not the product itself (gh-271, ADR 0080).
 */

const quiet = { warn: () => {}, debug: () => {} };

/** The configuration every agent needs, with nothing instrumented: this is about the hooks, not the drivers. */
const config = () =>
  testConfig("http://127.0.0.1:1/x", { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set() });

/** A meter whose clock a test can move, sampling every call so the arithmetic is visible. */
function meter(
  costPerHookMs: number,
  opts: {
    sampleEvery?: number;
    budgetMs?: number;
    window?: number;
    floor?: (typeof Sheddable)[keyof typeof Sheddable];
  } = {},
) {
  let clock = 0;
  const m = new OverheadMeter({
    sampleEvery: opts.sampleEvery ?? 1,
    windowRequests: opts.window ?? WINDOW_REQUESTS,
    budgetMs: opts.budgetMs ?? OVERHEAD_BUDGET_MS,
    ...(opts.floor === undefined ? {} : { floor: opts.floor }),
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

  /**
   * A floor under the level (gh-570). The benchmark holds one seam of the black box shut — the fine detail, or
   * the fine detail and the profile — to weigh what is behind it head to head (ADR 0027). The meter still sheds
   * above the floor when the hooks cost too much, and never recovers below it.
   */
  describe("a floor under the level", () => {
    it("starts at the floor, held by configuration and not for a reason", () => {
      const { m } = meter(0.001, { floor: Sheddable.Fine });
      expect(m.state().shed).toBe(Sheddable.Fine);
      expect(m.state().reason).toBe("");
      expect(m.keeping(Sheddable.Fine)).toBe(false);
      expect(m.keeping(Sheddable.Profile)).toBe(true);
    });

    it("with the profile as the floor, keeps nothing that can be shed", () => {
      const { m } = meter(0.001, { floor: Sheddable.Profile });
      expect(m.keeping(Sheddable.Fine)).toBe(false);
      expect(m.keeping(Sheddable.Profile)).toBe(false);
    });

    it("still sheds above the floor when the hooks cost too much, and says why", () => {
      const m = meter(0.4, { sampleEvery: 1, floor: Sheddable.Fine });
      windows(m, WINDOW_REQUESTS, 2); // 0.8 ms per request, over the budget: one more level
      expect(m.m.state().shed).toBe(Sheddable.Profile);
      expect(m.m.state().reason).toBe(ThrottleReasons.Latency);
    });

    it("never recovers below the floor", () => {
      const m = meter(0.4, { sampleEvery: 1, floor: Sheddable.Fine });
      windows(m, WINDOW_REQUESTS, 2);
      expect(m.m.state().shed).toBe(Sheddable.Profile);
      for (let r = 0; r < WINDOW_REQUESTS * 3; r += 1) {
        m.m.leave(m.m.enter());
        m.m.requestFinished();
      }
      expect(m.m.state().shed).toBe(Sheddable.Fine);
      expect(m.m.state().reason).toBe("");
    });

    it("without a floor, behaves as it always did", () => {
      const { m } = meter(0.001);
      expect(m.state().shed).toBe(Sheddable.Nothing);
    });
  });

  // The fourth promise of `product.md:241`, which shares the machinery: «if it approaches its memory budget, it
  // reduces the detail window and records it as a loss of coverage».
  it("gives up the detail for memory too, with its own reason", () => {
    const { m } = meter(0.001);
    m.shedForMemory();
    expect(m.state().shed).toBe(Sheddable.Fine);
    expect(m.state().reason).toBe(ThrottleReasons.Memory);
  });
});

describe("the shed it measures", () => {
  /**
   * A meter whose clock a test moves by hand, counting how many times it is read. One request is one hook
   * of `cost` ms; a window of one request so every request re-decides.
   */
  function shedMeter(over: { floor?: (typeof Sheddable)[keyof typeof Sheddable] } = {}) {
    let clock = 0;
    let reads = 0;
    const m = new OverheadMeter({
      sampleEvery: 1,
      windowRequests: 1,
      budgetMs: OVERHEAD_BUDGET_MS,
      ...(over.floor === undefined ? {} : { floor: over.floor }),
      now: () => {
        reads += 1;
        return clock;
      },
    });
    const request = (cost: number): void => {
      const started = m.enter();
      clock += cost;
      m.leave(started);
      m.requestFinished();
    };
    return { m, request, tick: (ms: number) => (clock += ms), reads: () => reads };
  }

  it("reads the closed episodes plus the one under way, and the last reason in force while it was shed", () => {
    const { m, request, tick } = shedMeter();
    request(0.8); // over the budget: the fine detail is shed for latency
    tick(10);
    request(0); // under half of it: it is kept again
    expect(m.shedMs()).toBe(10);
    expect(m.lastShedReason()).toBe("latency");
    // The reading includes the episode that is still open, whatever the window that reads it ends when.
    m.shedForMemory();
    expect(m.shedMs()).toBe(10);
    tick(2.5);
    expect(m.shedMs()).toBeCloseTo(12.5, 6);
    expect(m.lastShedReason()).toBe("memory");
  });

  it("keeps the reason in force while the level moves within the shed", () => {
    const { m, request } = shedMeter();
    m.shedForMemory(); // Fine, for memory
    request(0.8); // over the budget: one more level, and the reason in force is the latency's
    expect(m.state().shed).toBe(Sheddable.Profile);
    expect(m.lastShedReason()).toBe("latency");
  });

  it("keeps a thousand episodes as a sum, not a list", () => {
    const { m, request, tick } = shedMeter();
    for (let i = 0; i < 1000; i += 1) {
      request(0.8);
      tick(0.3);
      request(0);
    }
    expect(m.shedMs()).toBeCloseTo(300, 6);
    expect(m.state().shed).toBe(Sheddable.Nothing);
    // One more episode adds exactly its time: nothing of the episodes is kept, only their sum.
    request(0.8);
    tick(0.3);
    request(0);
    expect(m.shedMs()).toBeCloseTo(300.3, 6);
    expect(m.state().shed).toBe(Sheddable.Nothing);
  });

  it("never runs with the floor at or above the fine detail, even shedding above it", () => {
    const { m, request, tick } = shedMeter({ floor: Sheddable.Fine });
    request(0.8);
    request(0.8);
    expect(m.state().shed).toBe(Sheddable.Profile);
    expect(m.state().reason).toBe(ThrottleReasons.Latency);
    tick(1_000);
    // That shedding was the configuration's, and the meter never claims it (ADR 0210, point 1).
    expect(m.shedMs()).toBe(0);
    expect(m.lastShedReason()).toBeUndefined();
    request(0);
    request(0);
    expect(m.state().shed).toBe(Sheddable.Fine);
    expect(m.shedMs()).toBe(0);
  });

  it("reads no clock on a request that changes no level", () => {
    const s = shedMeter();
    const before = s.reads();
    for (let i = 0; i < 100; i += 1) {
      s.request(0.1); // under half the budget: the level never moves
    }
    // Two reads per request are the sampling it always had: enter and leave. The shed bookkeeping adds none,
    // which is the measurement paying for nothing on the path of a request (invariant 3).
    expect(s.reads() - before).toBe(200);
  });
});

describe("the agent", () => {
  /**
   * A meter whose window never closes while the test runs: the latency path is tested above, and the
   * decision under test here is the memory arithmetic alone.
   */
  const neverDeciding = () => new OverheadMeter({ sampleEvery: 1, windowRequests: 100_000 });

  /**
   * The memory tripwire of `product.md:241`, which used to cross on normal traffic: a fixed line below the
   * worst case of the two registers, so the coarse register — designed to fill to its cap, and a public
   * server sees a hundred distinct routes a minute, scanners and all — shed the fine detail at seventy-seven
   * routes and kept it shed, because its rows are never freed (gh-774).
   */
  it("keeps the fine detail when the coarse register fills to its designed cap", async () => {
    const overhead = neverDeciding();
    const fine = new FineRegister();
    const coarse = new CoarseRegister({ now: () => 1_000_000 });
    const agent = createAgent(config(), { log: quiet, overhead, fine, coarse });
    agent.start();
    try {
      const start = channel("http.server.request.start");
      const finish = channel("http.server.response.finish");
      const request = (route: string): void => {
        const req = { method: "GET", url: route };
        start.publish({ request: req });
        finish.publish({ request: req, response: { statusCode: 200 } });
      };
      // Seventy-seven distinct routes used to be the line: the register is past half its budget there, and
      // nothing is close to anything. The paths are what a scanner leaves behind: distinct, and not
      // identifier-shaped, so the template keeps them apart.
      for (let i = 0; i < 77; i += 1) request(`/r/a${i}`);
      expect(agent.stats.shed).toBe(Sheddable.Nothing);
      expect(fine.snapshot().coverage.requests).toBe(77);
      // Past the cap, where the scanner traffic leaves it: the register full is a designed state, not an
      // emergency.
      for (let i = 77; i < 200; i += 1) request(`/r/a${i}`);
      expect(agent.stats.shed).toBe(Sheddable.Nothing);
      expect(fine.snapshot().coverage.requests).toBe(200);
      // And the traffic coming back to one route does not stay without detail: the shed never happened.
      for (let i = 0; i < 200; i += 1) request("/one");
      expect(agent.stats.shed).toBe(Sheddable.Nothing);
      expect(fine.snapshot().coverage.requests).toBe(400);
      // The arithmetic the tripwire reads: the two registers at their reserve fit under the two budgets of
      // invariant 3, which is why the line is the reserve and not a fraction of a mebibyte (ADR 0067). The
      // reserves include the label tables the traffic fills (gh-765), so this is the worst case, whatever
      // the routes the process has seen.
      expect(fine.reservedBytes() + coarse.reservedBytes()).toBeLessThanOrEqual(FINE_MAX_BYTES + COARSE_MAX_BYTES);
    } finally {
      void agent.stop();
    }
  });

  /**
   * A route nobody has seen on every request — a scanner through the heuristic, or an Express 404. The
   * tables the registers key by it had no bound and no accounting, so the growth was invisible to both
   * (gh-765). Now each register is compared against its own reserve, the reserves include the tables, and
   * bounded growth is within the reserve.
   *
   * Since gh-756 a scanner whose paths carry values folds into the one template the heuristic gives them,
   * so the growth that remains is the one no rule of shape can stop: a value-less segment per request, a
   * plain word the heuristic keeps apart and that `product.md:106` does not guarantee. That is what this
   * drives.
   */
  it("a new route per request does not shed the detail, and the loss is said", async () => {
    const overhead = neverDeciding();
    const fine = new FineRegister();
    const coarse = new CoarseRegister({ now: () => 1_000_000 });
    const agent = createAgent(config(), { log: quiet, overhead, fine, coarse });
    agent.start();
    try {
      const start = channel("http.server.request.start");
      const finish = channel("http.server.response.finish");
      // Letters only, so the template keeps them apart: one distinct route per request. A segment with a
      // digit is a value the heuristic folds (gh-756), which is why the counter is written in letters and
      // not in its own number.
      const letters = (n: number): string => {
        let out = "";
        let rest = n;
        do {
          out = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[rest % 36] + out;
          rest = Math.floor(rest / 36);
        } while (rest > 0);
        return out;
      };
      for (let i = 0; i < 2000; i += 1) {
        const req = { method: "GET", url: `/scan/${letters(i)}` };
        start.publish({ request: req });
        finish.publish({ request: req, response: { statusCode: 404 } });
      }
      // The tables filled to their caps and stopped: the registers hold no more than they reserve, and a
      // register within its reserve does not shed (gh-774).
      expect(agent.stats.shed).toBe(Sheddable.Nothing);
      expect(fine.bytes()).toBeLessThanOrEqual(fine.reservedBytes());
      expect(coarse.bytes()).toBeLessThanOrEqual(coarse.reservedBytes());
      // And what the caps cost is said, the way every other loss is said (COB-01): the fine register folded
      // the routes it had no label for, and the coarse one says how many it cannot hold, at its lower bound.
      expect(fine.snapshot().coverage.labelsFolded).toBeGreaterThan(0);
      expect(coarse.snapshot().coverage.routesDropped).toBeGreaterThan(0);
    } finally {
      void agent.stop();
    }
  });

  /**
   * The gh-756 case — a new name per request — arriving at the reserve through its only door, an armed route.
   * The reserve writes only for armed routes, but an armed route whose traffic names a new fingerprint and a
   * new dependency on every request used to grow its tables for the life of the process, and the growth was
   * in none of the sums the agent reads (gh-805).
   */
  it("a new fingerprint and dependency per request on an armed route does not shed the detail", async () => {
    const overhead = neverDeciding();
    const fine = new FineRegister();
    const coarse = new CoarseRegister({ now: () => 1_000_000 });
    const prearm = new PrearmRegister();
    const agent = createAgent(
      { ...config(), instrument: new Set(["http"]) },
      { log: quiet, overhead, fine, coarse, prearm },
    );
    agent.start();
    try {
      // Armed before the traffic, the only order in which the reserve holds anything.
      prearm.arm("GET /cart", Date.now() - 1_000, 60_000);
      const start = channel("http.server.request.start");
      const finish = channel("http.server.response.finish");
      for (let i = 0; i < 2_000; i += 1) {
        const req = { method: "GET", url: "/cart" };
        start.publish({ request: req });
        // A new dependency and a new query on every request: the scanner traffic, aimed at the armed route.
        recordCall("postgres", `db-${i}:5432`, 3, false);
        const ctx = currentContext();
        if (!ctx) throw new Error("the agent did not open a request context");
        recordOperationIn(ctx, {
          kind: "query",
          fingerprint: { hash: String(i).padStart(16, "0"), text: "" },
          startedAt: 1,
          endedAt: 3,
        });
        finish.publish({ request: req, response: { statusCode: 200 } });
      }
      // The tables filled to their caps and stopped: the registers hold no more than they reserve, and a
      // register within its reserve does not shed (gh-774).
      expect(agent.stats.shed).toBe(Sheddable.Nothing);
      expect(fine.bytes()).toBeLessThanOrEqual(fine.reservedBytes());
      expect(coarse.bytes()).toBeLessThanOrEqual(coarse.reservedBytes());
      expect(prearm.bytes()).toBeLessThanOrEqual(prearm.reservedBytes());
      // And what the caps cost is said, the way every other loss is said (COB-01).
      expect(fine.snapshot().coverage.labelsFolded).toBeGreaterThan(0);
      expect(prearm.labelsFolded).toBeGreaterThan(0);
      // The arithmetic the tripwire reads: the three reserves fit under the three budgets of invariant 3
      // (ADR 0067), which is why the line is the reserve and not a fraction of a mebibyte.
      expect(fine.reservedBytes() + coarse.reservedBytes() + prearm.reservedBytes()).toBeLessThanOrEqual(
        FINE_MAX_BYTES + COARSE_MAX_BYTES + PREARM_MAX_BYTES,
      );
      // And the reserve is still doing its job: the armed route's requests are kept, folded or not.
      const reserve = prearm.reserveFor("GET", "/cart", Date.now());
      expect(reserve?.requests.length).toBeGreaterThan(0);
    } finally {
      void agent.stop();
    }
  });

  /**
   * The one state the tripwire exists for: a register holding more than it reserves, so the arithmetic of
   * ADR 0067 no longer holds. The detail goes first, and the loss is said with its reason.
   */
  it("sheds the detail for memory when a register holds more than it reserves", async () => {
    const overhead = neverDeciding();
    const fine = new FineRegister();
    // A register that grew beyond its cap: `bytes()` says more than the reserve, which the real register
    // cannot do, so a subclass stands in for the bug the tripwire is the last line against.
    class OverReserve extends CoarseRegister {
      override bytes(): number {
        return super.bytes() + 3 * 1024 * 1024;
      }
    }
    const coarse = new OverReserve({ now: () => 1_000_000 });
    const agent = createAgent(config(), { log: quiet, overhead, fine, coarse });
    agent.start();
    try {
      const start = channel("http.server.request.start");
      const finish = channel("http.server.response.finish");
      for (let i = 0; i < 2; i += 1) {
        const req = { method: "GET", url: `/r/${i}` };
        start.publish({ request: req });
        finish.publish({ request: req, response: { statusCode: 200 } });
      }
      expect(agent.stats.shed).toBe(Sheddable.Fine);
      expect(agent.stats.shedReason).toBe(ThrottleReasons.Memory);
      // The writing stopped, not just the reading: the first request landed before the shed, and the
      // second one, after.
      expect(fine.snapshot().coverage.requests).toBe(1);
    } finally {
      void agent.stop();
    }
  });

  // The same line, read from the reserve (gh-805): a tripwire that did not compare it would not read a
  // growth of it either.
  it("sheds the detail for memory when the reserve holds more than it reserves", async () => {
    const overhead = neverDeciding();
    const fine = new FineRegister();
    // A reserve that grew beyond its cap: `bytes()` says more than the reserve, which the real register
    // cannot do, so a subclass stands in for the bug the tripwire is the last line against.
    class OverReserve extends PrearmRegister {
      override bytes(): number {
        return super.bytes() + 3 * 1024 * 1024;
      }
    }
    const prearm = new OverReserve();
    const agent = createAgent(config(), { log: quiet, overhead, fine, prearm });
    agent.start();
    try {
      const start = channel("http.server.request.start");
      const finish = channel("http.server.response.finish");
      for (let i = 0; i < 2; i += 1) {
        const req = { method: "GET", url: `/r/${i}` };
        start.publish({ request: req });
        finish.publish({ request: req, response: { statusCode: 200 } });
      }
      expect(agent.stats.shed).toBe(Sheddable.Fine);
      expect(agent.stats.shedReason).toBe(ThrottleReasons.Memory);
      expect(fine.snapshot().coverage.requests).toBe(1);
    } finally {
      void agent.stop();
    }
  });

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
