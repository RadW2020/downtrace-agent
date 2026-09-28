import { describe, expect, it } from "vitest";
import { BUDGET, METRICS } from "../src/budget.ts";
import { coexistenceMarkdown, readCoexistence } from "../src/coexistence.ts";
import type { BenchReport, RoundResult } from "../src/report.ts";
import { round } from "../src/stats.ts";
import { evaluate } from "../src/verdict.ts";

/**
 * The reading of the coexistence campaign (ESC-16, gh-615), checked on structure, not values: the report is
 * assembled the way `runBench` assembles it — the metrics are what the benchmark's own rule computes from the
 * rounds — and the reading is checked against what the report carries, never against a number invented here.
 * What the reading must never do is name a budget verdict: the deltas are the tracker's cost (gh-615).
 */
const COMPARISONS = METRICS.length + 1;

interface RoundSpec {
  p99: number;
  cpu: number;
  rss: number;
  /** The agent's own hook estimate the round's sink read; undefined is a round that did not report it. */
  hook?: number | undefined;
  tracker?: { envelopes: number; transactions: number; events: number; rejected: number } | undefined;
}

const samplesFor = (p99: number): number[] => Array.from({ length: 100 }, (_, i) => 10 + i + p99);

function roundOf(n: number, variant: "baseline" | "agent", spec: RoundSpec): RoundResult {
  return {
    round: n,
    variant,
    warmup: { seconds: 3, clean: true, lastErrors: 0 },
    load: {
      targetRps: 200,
      achievedRps: 200,
      requested: 100,
      completed: 100,
      errors: 0,
      elapsedMs: 12_000,
      overall: { p50: 10, p95: 20, p99: spec.p99, max: 100 },
      byEndpoint: {},
      samples: samplesFor(spec.p99),
    },
    usage: { cpuPct: spec.cpu, rssMaxMb: spec.rss, elu: 0.1 },
    poolWait: { totalMs: 0, maxMs: 0, maxAt: undefined },
    otherCpuPct: 1,
    checkpointWriteMs: 0,
    checkpointCount: 0,
    sink: {
      batches: 10,
      intervals: 10,
      endpoints: 4,
      requests: 100,
      rejected: 0,
      ...(spec.hook === undefined ? {} : { hookMsPerRequest: spec.hook }),
    },
    ...(spec.tracker === undefined ? {} : { tracker: spec.tracker }),
  };
}

/** A report the way `runBench` leaves it: the metrics are the benchmark's own rule applied to the rounds. */
function reportOf(baseline: RoundSpec[], agent: RoundSpec[], reason?: string): BenchReport {
  const rounds: RoundResult[] = [];
  for (let i = 0; i < Math.min(baseline.length, agent.length); i++) {
    const b = baseline[i];
    const a = agent[i];
    if (b === undefined || a === undefined) break;
    rounds.push(roundOf(i + 1, "baseline", b), roundOf(i + 1, "agent", a));
  }
  const picked = (list: RoundSpec[]) => list.map((s) => ({ p99Ms: s.p99, cpuPct: s.cpu, rssMb: s.rss }));
  const metrics =
    baseline.length > 0 && agent.length > 0
      ? evaluate(picked(baseline), picked(agent), BUDGET, {
          baseline: baseline.map((s) => samplesFor(s.p99)),
          agent: agent.map((s) => samplesFor(s.p99)),
          seed: 1,
        }).metrics
      : [];
  return {
    generatedAt: "2026-09-28T12:00:00.000Z",
    node: "v24.0.0",
    platform: "darwin-arm64",
    host: { cores: 4, memoryMb: 8192, cpu: "test cpu" },
    subject: {
      agentPath: "packages/agent/src/register.ts",
      version: "0.8.1",
      commit: "abcdef0123456789",
      dirty: false,
      source: "working-tree",
    },
    config: {
      rounds: Math.min(baseline.length, agent.length),
      warmupCleanSec: 3,
      warmupMaxSec: 30,
      measureSec: 12,
      rps: 200,
      seed: 1,
      agentPath: "packages/agent/src/register.ts",
    },
    rounds,
    metrics,
    verdict: reason === undefined ? "pass" : "inconclusive",
    ...(reason === undefined ? {} : { reason }),
  };
}

const comparison = {
  name: "the tracker beside the agent",
  module: "packages/reference-app/src/sentry.ts",
  version: "10.75.0",
};

/** Four rounds whose agent side is uniformly above the baseline side: every difference has the same sign. */
const uniform = {
  baseline: Array.from({ length: 4 }, () => ({ p99: 20, cpu: 30, rss: 500, hook: 0.05 })),
  agent: Array.from({ length: 4 }, () => ({ p99: 24, cpu: 33, rss: 510, hook: 0.051 })),
};

describe("the reading of the coexistence campaign", () => {
  it("reads one row per metric, with the benchmark's own rule and the paired differences it tests", () => {
    const report = reportOf(uniform.baseline, uniform.agent);
    const reading = readCoexistence(report, comparison, COMPARISONS);

    expect(reading.metrics.map((m) => m.metric)).toEqual([...METRICS]);
    for (const m of reading.metrics) {
      const v = report.metrics.find((x) => x.metric === m.metric);
      expect(v).toBeDefined();
      expect(m.baseline).toBe(v?.baselineMedian);
      expect(m.agent).toBe(v?.agentMedian);
      expect(m.delta).toBe(v?.delta);
      expect(m.noise).toBe(v?.noise);
      expect(m.exact).toBe(true);
      // Same sign in all four paired differences: the smallest p four differences can give is 2 of 16.
      expect(m.p).toBeCloseTo(2 / 2 ** 4, 9);
      // And the level the run shares among its four comparisons is below that: the row reports, it does not resolve.
      expect(m.resolved).toBe(false);
    }
    const cpu = reading.metrics.find((m) => m.metric === "cpuPct");
    expect(cpu?.differences).toEqual(uniform.agent.map((a, i) => round(a.cpu - (uniform.baseline[i]?.cpu ?? 0), 3)));
  });

  it("reads the agent's own hook estimate in both configurations, paired round by round", () => {
    const report = reportOf(uniform.baseline, uniform.agent);
    const reading = readCoexistence(report, comparison, COMPARISONS);

    expect(reading.hook.baseline).toBe(0.05);
    expect(reading.hook.agent).toBe(0.051);
    expect(reading.hook.missing).toBe(0);
    expect(reading.hook.differences).toEqual([0.001, 0.001, 0.001, 0.001]);
    expect(reading.hook.p).toBeCloseTo(2 / 2 ** 4, 9);
    expect(reading.hook.resolved).toBe(false);
  });

  it("a round that did not report its estimate on one side is a hole: the comparison is not made, and it says so", () => {
    const baseline = uniform.baseline.map((s, i) => (i === 1 ? { ...s, hook: undefined } : s));
    const report = reportOf(baseline, uniform.agent);
    const reading = readCoexistence(report, comparison, COMPARISONS);

    expect(reading.hook.missing).toBe(1);
    expect(reading.hook.differences).toEqual([]);
    expect(reading.hook.resolved).toBe(false);
    expect(reading.hook.reason).toContain("1 of 4");
  });

  it("adds up what the tracker shipped to its local sink across the rounds that loaded it", () => {
    const agent = uniform.agent.map((s, i) => ({
      ...s,
      tracker: { envelopes: i + 1, transactions: (i + 1) * 2, events: 1, rejected: 0 },
    }));
    const report = reportOf(uniform.baseline, agent);
    const reading = readCoexistence(report, comparison, COMPARISONS);

    expect(reading.tracker).toMatchObject({ envelopes: 10, transactions: 20, events: 4, rejected: 0 });
    expect(reading.tracker.perRound.map((x) => x.round)).toEqual([1, 2, 3, 4]);
  });

  it("a run that never got clean reads its reason, not a table", () => {
    const report = reportOf([], [], "baseline#1: app not clean after 30 s of warmup");
    const reading = readCoexistence(report, comparison, COMPARISONS);

    expect(reading.metrics).toEqual([]);
    expect(reading.reason).toBe("baseline#1: app not clean after 30 s of warmup");
    expect(reading.hook.resolved).toBe(false);
    const md = coexistenceMarkdown(reading);
    expect(md).toContain("app not clean after 30 s");
    expect(md).not.toContain("What the tracker costs");
  });

  it("says what it is not: a reported cost, and no verdict of the budget", () => {
    const report = reportOf(uniform.baseline, uniform.agent);
    const reading = readCoexistence(report, comparison, COMPARISONS);
    const md = coexistenceMarkdown(reading);

    expect(md).toContain("not** the instrumentation's budget");
    expect(md).toContain("the tracker's cost is reported");
    expect(md).toContain("#### The per-round differences behind each row");
    expect(md).toContain("hook estimate (ms/request): +0.001, +0.001, +0.001, +0.001");
    expect(md).toContain("The tracker shipped 0 envelope(s)");
  });
});
