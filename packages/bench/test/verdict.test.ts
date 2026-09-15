import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/prng.ts";
import { pooledPercentile, splitHalfNoise } from "../src/stats.ts";
import {
  type Aborted,
  applyNeighbourCpu,
  applyRoundErrors,
  applyUndeliveredBatches,
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

  // Before gh-572 this top-level reason did not exist at all: `evaluate()` returned only `{ metrics, verdict }`,
  // and nothing else in the chain describes a metrics-driven fail — only a console-only fallback in
  // `bench-cli.ts` ever produced this text, which never reached the JSON report or the Markdown.
  it("names the metric that broke the budget in its own reason, on a fail", () => {
    const { verdict, reason } = evaluate([r(5.0), r(5.2), r(4.9)], [r(10.0), r(10.4), r(9.8)]);
    expect(verdict).toBe("fail");
    expect(reason).toMatch(/^overhead budget exceeded: p99Ms Δ/);
    expect(reason).not.toContain("cpuPct"); // cpuPct passed: only the broken metric is named
  });

  it("names the metric in its reason on an inconclusive too", () => {
    const { verdict, reason } = evaluate([r(3.0), r(9.0), r(5.0)], [r(7.0), r(7.5), r(6.8)]);
    expect(verdict).toBe("inconclusive");
    expect(reason).toMatch(/^machine noise exceeds the budget for p99Ms Δ/);
  });

  it("carries no reason at all when every metric passes", () => {
    const { verdict, reason } = evaluate([r(5.0), r(5.2), r(4.9)], [r(5.4), r(5.5), r(5.3)]);
    expect(verdict).toBe("pass");
    expect(reason).toBeUndefined();
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
      applyRoundErrors("pass", undefined, [
        { variant: "baseline", round: 1, ...clean },
        { variant: "agent", round: 1, ...clean },
      ]),
    ).toEqual({ verdict: "pass" });
  });
  it("fails when the agent variant produced request errors, whatever the numbers said", () => {
    const r = applyRoundErrors("pass", undefined, [
      { variant: "agent", round: 2, errors: 3, errorStatuses: { "502": 3 } },
    ]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/agent rounds had request errors — agent#2: 3 failed \(502×3\)/);
  });
  it("is inconclusive — never a pass — when only baseline rounds had errors", () => {
    const r = applyRoundErrors("pass", undefined, [
      { variant: "baseline", round: 1, errors: 586, errorStatuses: { "503": 500, timeout: 86 } },
    ]);
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toMatch(/baseline rounds had request errors/);
  });
  it("keeps a fail when baseline rounds had errors but the agent already failed", () => {
    expect(applyRoundErrors("fail", undefined, [{ variant: "baseline", round: 1, errors: 1 }]).verdict).toBe("fail");
  });
  it("says what the application itself reported, not only how many requests failed", () => {
    const r = applyRoundErrors("pass", undefined, [
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

  // The defect gh-572 fixes: this function used to drop any reason it was seeded with the moment it had nothing
  // new to say, which silently erased a metrics-driven fail or inconclusive from `evaluate()`.
  it("preserves a seed reason when nothing here adds to it", () => {
    expect(
      applyRoundErrors("fail", "overhead budget exceeded: p99Ms Δ+333008ms (budget 1, noise 2522)", [
        { variant: "baseline", round: 1, ...clean },
        { variant: "agent", round: 1, ...clean },
      ]),
    ).toEqual({ verdict: "fail", reason: "overhead budget exceeded: p99Ms Δ+333008ms (budget 1, noise 2522)" });
  });

  // Same composition every later rule in the chain uses: the seed comes first, this rule's own text after it.
  it("appends its own reason after a seed reason instead of replacing it", () => {
    const r = applyRoundErrors("fail", "overhead budget exceeded: p99Ms Δ5ms (budget 1, noise 0.3)", [
      { variant: "agent", round: 2, errors: 3, errorStatuses: { "502": 3 } },
    ]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toBe(
      "overhead budget exceeded: p99Ms Δ5ms (budget 1, noise 0.3) · agent rounds had request errors — agent#2: 3 failed (502×3)",
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

describe("applyUndeliveredBatches", () => {
  const round = (variant: "baseline" | "agent", n: number, batches?: number) => ({
    variant,
    round: n,
    batches,
  });

  it("fails when an agent round delivered nothing, naming the round", () => {
    const got = applyUndeliveredBatches("pass", undefined, [round("baseline", 1), round("agent", 1, 0)]);
    expect(got.verdict).toBe("fail");
    expect(got.reason).toContain("agent#1");
    expect(got.reason).toContain("no batches");
  });

  it("keeps the verdict and the reason untouched when every agent round delivered", () => {
    expect(applyUndeliveredBatches("pass", undefined, [round("baseline", 1), round("agent", 1, 3)])).toEqual({
      verdict: "pass",
    });
    expect(applyUndeliveredBatches("inconclusive", "machine noise", [round("agent", 1, 1)])).toEqual({
      verdict: "inconclusive",
      reason: "machine noise",
    });
  });

  // A round with no sink has `batches` undefined and says nothing about delivery. In the normal benchmark that is
  // every baseline round.
  it("says nothing about rounds that had no sink", () => {
    expect(applyUndeliveredBatches("pass", undefined, [round("baseline", 1), round("baseline", 2)])).toEqual({
      verdict: "pass",
    });
  });

  // With `baselineEnv` (bench-instruments) the baseline is another agent configuration and ships too. A paired
  // comparison where that side delivered nothing is as broken as one where the other did (gh-152).
  it("fails when the baseline had a sink and delivered nothing either", () => {
    const got = applyUndeliveredBatches("pass", undefined, [round("baseline", 1, 0), round("agent", 1, 5)]);
    expect(got.verdict).toBe("fail");
    expect(got.reason).toContain("baseline#1");
    expect(got.reason).not.toContain("agent#1");
  });

  it("adds its reason to one that was already there instead of hiding it", () => {
    const got = applyUndeliveredBatches("fail", "overhead budget exceeded", [round("agent", 2, 0)]);
    expect(got.verdict).toBe("fail");
    expect(got.reason).toBe(
      "overhead budget exceeded · rounds delivered no batches to the sink (agent#2): nothing was measured about shipping",
    );
  });

  // How many batches a round produces depends on the interval and the round's length; only zero is a broken setup.
  it("does not judge how many batches arrived, only that some did", () => {
    expect(applyUndeliveredBatches("pass", undefined, [round("agent", 1, 1)]).verdict).toBe("pass");
  });
});

/**
 * gh-572: `fixtures/slow-agent.ts` stalls one request in fifty by 200 ms — a real p99 regression — but never
 * ships a batch, because it is a fake `http.Server` patch and not the real instrumentation. Before this fix, that
 * always tripped `applyUndeliveredBatches` (gh-134) and its "no batches" text was the *only* reason on the
 * report: the fixture's own regression, the one thing it exists to prove, never appeared. This reproduces the
 * exact shape of that run through the same functions and order `bench.ts`'s `runBench()` calls them in, without
 * a full timed benchmark: `evaluate()` → `applyRoundErrors` → `applyUndeliveredBatches`.
 */
describe("gh-572: a metrics fail composes with the undelivered-batches rule instead of being hidden by it", () => {
  it("names the latency regression first and the undelivered batches second", () => {
    const { verdict: metricsVerdict, reason: metricsReason } = evaluate(
      [r(5.0), r(5.2), r(4.9)],
      [r(200.0), r(198.0), r(201.0)], // the fixture's 200 ms stall dominates the pooled p99
    );
    expect(metricsVerdict).toBe("fail");

    const measured = applyRoundErrors(metricsVerdict, metricsReason, [
      { variant: "baseline", round: 1, errors: 0 },
      { variant: "agent", round: 1, errors: 0 },
    ]);

    // The fixture never ships: every agent round delivered zero batches to the sink.
    const delivered = applyUndeliveredBatches(measured.verdict, measured.reason, [
      { variant: "baseline", round: 1 }, // no sink on the baseline
      { variant: "agent", round: 1, batches: 0 },
    ]);

    expect(delivered.verdict).toBe("fail");
    expect(delivered.reason).toMatch(/^overhead budget exceeded: p99Ms Δ/);
    const metricsIdx = delivered.reason?.indexOf("overhead budget exceeded") ?? -1;
    const batchesIdx = delivered.reason?.indexOf("rounds delivered no batches") ?? -1;
    expect(metricsIdx).toBeGreaterThanOrEqual(0);
    expect(batchesIdx).toBeGreaterThan(metricsIdx); // latency named before batches, not instead of it
    expect(delivered.reason).toContain("agent#1");
    expect(delivered.reason).toContain("no batches");
  });

  // The rule this ticket must not weaken: real instrumentation that ships nothing still fails, and the reason
  // still names it, with no metrics reason in front of it when the metrics themselves were fine.
  it("still fails on undelivered batches alone when the metrics pass", () => {
    const { verdict: metricsVerdict, reason: metricsReason } = evaluate(
      [r(5.0), r(5.2), r(4.9)],
      [r(5.4), r(5.5), r(5.3)],
    );
    expect(metricsVerdict).toBe("pass");

    const measured = applyRoundErrors(metricsVerdict, metricsReason, [
      { variant: "baseline", round: 1, errors: 0 },
      { variant: "agent", round: 1, errors: 0 },
    ]);
    const delivered = applyUndeliveredBatches(measured.verdict, measured.reason, [
      { variant: "baseline", round: 1 },
      { variant: "agent", round: 1, batches: 0 },
    ]);

    expect(delivered.verdict).toBe("fail");
    expect(delivered.reason).toBe(
      "rounds delivered no batches to the sink (agent#1): nothing was measured about shipping",
    );
  });
});

/**
 * The budget asks "is it over?", and that is answered by comparing the noise with the margin over the budget —
 * not with Δ. Comparing Δ with the noise answers "does the overhead exist?", which nobody was asking, and it is
 * always yes for a metric whose Δ is much larger than its noise (gh-196).
 */
describe("the margin over the budget is what has to be resolvable", () => {
  const rounds = (values: number[]): RoundMetrics[] => values.map((cpuPct) => ({ p99Ms: 0, cpuPct, rssMb: 0 }));
  const cpuOf = (baseline: number[], agent: number[]) =>
    evaluate(rounds(baseline), rounds(agent), { p99Ms: 1, cpuPct: 3, rssMb: 64 }).metrics.find(
      (m) => m.metric === "cpuPct",
    );

  // The run that found this: Δ 3.026 over a budget of 3, with 0.840 of noise. The machine cannot tell 3.026
  // from 2.9, so calling it a failure claims something the measurement does not support.
  it("does not call a failure when the excess is smaller than the noise", () => {
    const verdict = cpuOf([24.0, 24.42, 24.238], [27.0, 27.5, 27.264]);
    expect(verdict?.delta).toBeCloseTo(3.026, 3);
    expect(verdict?.noise).toBeCloseTo(0.42, 3);
    expect(verdict?.status).toBe("inconclusive");
  });

  it("still calls a failure when the excess is bigger than the noise", () => {
    // A guardrail that cannot fail is decoration: 3 pp over the budget against 0.42 of noise is resolved.
    const verdict = cpuOf([24.0, 24.42, 24.238], [30.0, 30.5, 30.264]);
    expect(verdict?.status).toBe("fail");
  });

  it("says ok below the budget however noisy the machine", () => {
    // Not being over does not need resolving: the question only arises once the budget is crossed.
    const verdict = cpuOf([10, 30, 20], [11, 31, 21]);
    expect(verdict?.delta).toBeLessThan(3);
    expect(verdict?.noise).toBe(20);
    expect(verdict?.status).toBe("ok");
  });

  it("does not call a failure on a tie", () => {
    // Excess exactly equal to the noise: a tie is not evidence, and the budget is not crossed by agreement.
    // baseline median 24.5, noise 1; agent median 28.5 → delta 4, excess exactly 1.
    const verdict = cpuOf([24, 25], [28, 29]);
    expect((verdict?.delta ?? 0) - 3).toBeCloseTo(verdict?.noise ?? -1, 6);
    expect(verdict?.status).toBe("inconclusive");
  });
});

/**
 * The rounds alternate so that each pair sees the same machine. On a shared box that assumption breaks silently:
 * the benchmark's collapses lined up one-to-one with another CI runner's jobs on the same VM (gh-200).
 */
describe("a pair that did not see the same machine", () => {
  const pair = (round: number, variant: "baseline" | "agent", otherCpuPct: number | undefined) => ({
    round,
    variant,
    otherCpuPct,
  });

  it("leaves a run alone when both halves saw the same neighbours", () => {
    const out = applyNeighbourCpu("pass", undefined, [
      pair(1, "baseline", 12),
      pair(1, "agent", 14),
      pair(2, "baseline", 11),
      pair(2, "agent", 10),
    ]);
    expect(out.verdict).toBe("pass");
    expect(out.reason).toBeUndefined();
  });

  // Round 9 of the run that found this: the agent's half ran while `e2e` and `node` were on the neighbour.
  it("cannot conclude when the agent's half had the machine taken from it", () => {
    const out = applyNeighbourCpu("pass", undefined, [pair(9, "baseline", 10), pair(9, "agent", 180)]);
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toContain("9");
  });

  // The other direction matters more, not less: contaminating the baseline flatters the agent.
  it("cannot conclude when it was the baseline's half instead", () => {
    const out = applyNeighbourCpu("pass", undefined, [pair(7, "baseline", 190), pair(7, "agent", 12)]);
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toContain("7");
  });

  it("does not turn a failure into an inconclusive", () => {
    // A guardrail that a busy neighbour can switch off is not a guardrail.
    const out = applyNeighbourCpu("fail", "over budget", [pair(1, "baseline", 10), pair(1, "agent", 180)]);
    expect(out.verdict).toBe("fail");
    expect(out.reason).toContain("over budget");
  });

  it("says nothing when the machine could not be read", () => {
    // Not knowing is not detecting: on a platform with no /proc/stat the verdict stands as measured.
    const out = applyNeighbourCpu("pass", undefined, [pair(1, "baseline", undefined), pair(1, "agent", undefined)]);
    expect(out.verdict).toBe("pass");
    expect(out.reason).toBeUndefined();
  });

  it("says nothing when only one half could be read", () => {
    const out = applyNeighbourCpu("pass", undefined, [pair(1, "baseline", 10), pair(1, "agent", undefined)]);
    expect(out.verdict).toBe("pass");
  });
});
