import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/prng.ts";
import { pooledPercentile, splitHalfNoise } from "../src/stats.ts";
import {
  type Aborted,
  applyRoundErrors,
  combineWithAbort,
  evaluate,
  type RoundMetrics,
  warmupVerdict,
} from "../src/verdict.ts";

const r = (p99Ms: number, cpuPct = 10, rssMb = 100): RoundMetrics => ({ p99Ms, cpuPct, rssMb });

describe("evaluate", () => {
  it("passes when every delta is within budget", () => {
    const { metrics, verdict } = evaluate([r(5.0), r(5.2), r(4.9)], [r(5.4), r(5.5), r(5.3)]);
    expect(verdict).toBe("pass");
    expect(metrics.find((m) => m.metric === "p99Ms")).toMatchObject({ delta: 0.4, noise: 0.3, status: "ok" });
  });

  it("fails when a delta exceeds both the budget and the machine noise", () => {
    const { metrics, verdict } = evaluate([r(5.0), r(5.2), r(4.9)], [r(10.0), r(10.4), r(9.8)]);
    expect(verdict).toBe("fail");
    expect(metrics.find((m) => m.metric === "p99Ms")?.status).toBe("fail");
    expect(metrics.find((m) => m.metric === "cpuPct")?.status).toBe("ok");
  });

  it("is inconclusive when the delta exceeds the budget but not the noise", () => {
    const { metrics, verdict } = evaluate([r(3.0), r(9.0), r(5.0)], [r(7.0), r(7.5), r(6.8)]);
    // baseline median 5, agent median 7 → delta 2 > budget 1, but baseline noise is 6
    expect(verdict).toBe("inconclusive");
    expect(metrics.find((m) => m.metric === "p99Ms")?.status).toBe("inconclusive");
  });

  it("fail wins over inconclusive", () => {
    const { verdict } = evaluate([r(3.0, 10), r(9.0, 10), r(5.0, 10)], [r(7.0, 20), r(7.5, 20), r(6.8, 20)]);
    expect(verdict).toBe("fail"); // cpu +10 pp, no noise
  });

  it("rejects empty input", () => {
    expect(() => evaluate([], [r(1)])).toThrow(/at least one round/);
  });
});

/** Synthetic latencies shaped like the real app: a fast bulk and a slow tail. */
function samples(seed: number, n: number, shiftMs = 0): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = rand();
    const base = u < 0.9 ? 1 + rand() * 4 : 10 + rand() * 15; // 90 % in 1–5 ms, 10 % in 10–25 ms
    out.push(base + shiftMs);
  }
  return out;
}

describe("evaluate with pooled latency samples", () => {
  const rounds = (p99: number): RoundMetrics[] => [r(p99), r(p99), r(p99), r(p99), r(p99)];
  const baselinePools = [1, 2, 3, 4, 5].map((s) => samples(s, 2400));

  it("two identical distributions come out equal within the noise: pass", () => {
    const agentPools = [11, 12, 13, 14, 15].map((s) => samples(s, 2400));
    const { metrics, verdict } = evaluate(rounds(20), rounds(20), undefined, {
      baseline: baselinePools,
      agent: agentPools,
      seed: 42,
    });
    const p99 = metrics.find((m) => m.metric === "p99Ms");
    expect(p99?.method).toBe("pooled-p99");
    expect(p99?.samples).toBe(12000);
    expect(Math.abs(p99?.delta ?? 99)).toBeLessThan(0.3);
    expect(verdict).toBe("pass");
  });

  it("an agent that adds 5 ms to every request is always caught: fail", () => {
    const agentPools = [1, 2, 3, 4, 5].map((s) => samples(s, 2400, 5));
    const { metrics, verdict } = evaluate(rounds(20), rounds(25), undefined, {
      baseline: baselinePools,
      agent: agentPools,
      seed: 42,
    });
    const p99 = metrics.find((m) => m.metric === "p99Ms");
    expect(p99?.delta).toBeGreaterThan(4.5);
    expect(p99?.delta).toBeLessThan(5.5);
    expect(p99?.noise).toBeLessThan(1);
    expect(p99?.status).toBe("fail");
    expect(verdict).toBe("fail");
  });

  it("split-half noise is deterministic for a seed and small for a large pool", () => {
    const pool = baselinePools.flat();
    const a = splitHalfNoise(pool, 99, 20, 7);
    const b = splitHalfNoise(pool, 99, 20, 7);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(splitHalfNoise([1, 2, 3], 99)).toBe(0);
  });

  it("pooledPercentile matches the percentile of the concatenation", () => {
    expect(
      pooledPercentile(
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
        50,
      ),
    ).toBe(3);
    expect(pooledPercentile([[10], [1, 2]], 99)).toBe(10);
  });

  it("a stall in one agent round does not fail the run: the other rounds do not corroborate it", () => {
    // 3 rounds of 600 requests; in one of them a 200 ms stall queues 40 of them, exactly the shape of run 33967120965.
    const pools = (stallRound: number) =>
      [0, 1, 2].map((i) => {
        const round = samples(20 + i, 600);
        if (i === stallRound) for (let k = 0; k < 40; k++) round[k] = 200 + k;
        return round;
      });
    const { metrics, verdict } = evaluate(rounds(20), rounds(20), undefined, {
      baseline: [0, 1, 2].map((i) => samples(i + 1, 600)),
      agent: pools(1),
      seed: 42,
    });
    const p99 = metrics.find((m) => m.metric === "p99Ms");
    expect(p99?.delta).toBeGreaterThan(10); // the pooled p99 is dragged up on its own
    expect(p99?.status).toBe("inconclusive");
    expect(p99?.reason).toMatch(/one round dominates the tail \(1\/3/);
    expect(verdict).toBe("inconclusive");
  });

  it("the same stall in every agent round is a real tail regression: fail", () => {
    const withStall = [0, 1, 2].map((i) => {
      const round = samples(30 + i, 600);
      for (let k = 0; k < 40; k++) round[k] = 200 + k;
      return round;
    });
    const { metrics } = evaluate(rounds(20), rounds(20), undefined, {
      baseline: [0, 1, 2].map((i) => samples(i + 1, 600)),
      agent: withStall,
      seed: 42,
    });
    const p99 = metrics.find((m) => m.metric === "p99Ms");
    expect(p99?.status).toBe("fail");
  });

  it("a baseline round that drifted is counted as noise, not as precision", () => {
    const drifted = [samples(1, 2400), samples(2, 2400, 2), samples(3, 2400)];
    const { metrics } = evaluate(rounds(20), rounds(20), undefined, {
      baseline: drifted,
      agent: [11, 12, 13].map((s) => samples(s, 2400)),
      seed: 42,
    });
    const p99 = metrics.find((m) => m.metric === "p99Ms");
    expect(p99?.noiseSource).toBe("round-spread");
    expect(p99?.noise).toBeGreaterThan(1.5);
    expect(p99?.status).toBe("ok");
  });

  it("without pools the latency metric keeps the median-of-rounds method", () => {
    const { metrics } = evaluate([r(5), r(5), r(5)], [r(5.2), r(5.2), r(5.2)]);
    expect(metrics.find((m) => m.metric === "p99Ms")?.method).toBe("median-of-rounds");
  });
});

describe("applyRoundErrors", () => {
  const clean = { errors: 0 };
  it("leaves a clean run alone", () => {
    expect(
      applyRoundErrors("pass", [
        { variant: "baseline", round: 1, ...clean },
        { variant: "agent", round: 1, ...clean },
      ]),
    ).toEqual({ verdict: "pass" });
  });
  it("fails when the agent variant produced request errors, whatever the numbers said", () => {
    const r = applyRoundErrors("pass", [{ variant: "agent", round: 2, errors: 3, errorStatuses: { "502": 3 } }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/agent rounds had request errors — agent#2: 3 failed \(502×3\)/);
  });
  it("is inconclusive — never a pass — when only baseline rounds had errors", () => {
    const r = applyRoundErrors("pass", [
      { variant: "baseline", round: 1, errors: 586, errorStatuses: { "503": 500, timeout: 86 } },
    ]);
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toMatch(/baseline rounds had request errors/);
  });
  it("keeps a fail when baseline rounds had errors but the agent already failed", () => {
    expect(applyRoundErrors("fail", [{ variant: "baseline", round: 1, errors: 1 }]).verdict).toBe("fail");
  });
  it("says what the application itself reported, not only how many requests failed", () => {
    const r = applyRoundErrors("pass", [
      {
        variant: "baseline",
        round: 1,
        errors: 750,
        errorStatuses: { "500": 659, "503": 88, timeout: 3 },
        firstErrors: [
          "503 GET /me PoolTimeoutError: timed out waiting for a database connection",
          "500 POST /checkout X",
        ],
      },
    ]);
    expect(r.reason).toBe(
      "baseline rounds had request errors, nothing can be measured — baseline#1: 750 failed (500×659, 503×88, timeout×3) — app: 503 GET /me PoolTimeoutError: timed out waiting for a database connection | 500 POST /checkout X",
    );
  });
});

describe("warmupVerdict", () => {
  const cold = {
    round: 1,
    seconds: 30,
    lastErrors: 88,
    lastErrorStatuses: { "503": 88 },
    firstErrors: ["503 GET /products ColdStartError: database not ready yet"],
  };
  it("is inconclusive with the full story when the baseline never gets clean", () => {
    const r = warmupVerdict({ variant: "baseline", ...cold });
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toBe(
      "baseline round could not warm up, nothing can be measured — baseline#1: app not clean after 30 s of warmup — last second: 88 failed (503×88) — app: 503 GET /products ColdStartError: database not ready yet",
    );
  });
  it("is a fail when the agent variant never gets clean: the agent breaks the app", () => {
    const r = warmupVerdict({ variant: "agent", ...cold, round: 2 });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/^agent round could not warm up — agent#2: app not clean after 30 s of warmup/);
  });
  it("copes without application lines", () => {
    const r = warmupVerdict({
      variant: "baseline",
      round: 1,
      seconds: 5,
      lastErrors: 1,
      lastErrorStatuses: { "500": 1 },
    });
    expect(r.reason).toMatch(/last second: 1 failed \(500×1\)$/);
  });
});

describe("combineWithAbort", () => {
  const abortedBaseline: Aborted = { verdict: "inconclusive", reason: "baseline round could not warm up" };
  const abortedAgent: Aborted = { verdict: "fail", reason: "agent round could not warm up" };

  it("without an abort the measured verdict stands", () => {
    expect(combineWithAbort({ verdict: "pass" }, undefined)).toEqual({ verdict: "pass" });
  });

  it("an unmeasurable baseline round never rescues a fail the measured rounds already earned", () => {
    const r = combineWithAbort(
      { verdict: "fail", reason: "agent rounds had request errors — agent#1: 3 failed (502×3)" },
      abortedBaseline,
    );
    expect(r.verdict).toBe("fail");
    expect(r.reason).toBe(
      "agent rounds had request errors — agent#1: 3 failed (502×3) · baseline round could not warm up",
    );
  });

  it("a fail on the numbers alone still wins, and says so", () => {
    const r = combineWithAbort({ verdict: "fail" }, abortedBaseline);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toBe(
      "the rounds that were measured exceeded the overhead budget · baseline round could not warm up",
    );
  });

  it("with nothing failing in the measured rounds, the abort decides", () => {
    expect(combineWithAbort({ verdict: "pass" }, abortedBaseline)).toEqual(abortedBaseline);
    expect(combineWithAbort({ verdict: "inconclusive" }, abortedAgent)).toEqual(abortedAgent);
  });
});
