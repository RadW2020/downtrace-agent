import { describe, expect, it } from "vitest";
import { hooksOf, type ProfileReading, profileMarkdown } from "../src/profile-reading.ts";
import { type BenchReport, hooksShare, type RoundResult } from "../src/report.ts";

// The numbers of the run that found the bug (DT-21): 1 pair, 200 rps, the agent's estimate 0.0342 ms of CPU
// per request, and 2.907 pp of one core measured between the halves.
const RPS = 200;
const HOOK_MS = 0.0342;

function roundOf(variant: RoundResult["variant"], cpuPct: number, hookMsPerRequest?: number): RoundResult {
  return {
    round: 1,
    variant,
    warmup: { seconds: 1, clean: true, lastErrors: 0 },
    load: {
      targetRps: RPS,
      achievedRps: RPS,
      requested: 4000,
      completed: 4000,
      errors: 0,
      elapsedMs: 20000,
      overall: { p50: 2, p95: 4, p99: 6, max: 9 },
      byEndpoint: {},
      samples: [],
    },
    usage: { cpuPct, rssMaxMb: 80, elu: 0.4 },
    poolWait: { totalMs: 0, maxMs: 0, maxAt: undefined },
    otherCpuPct: 0,
    checkpointWriteMs: 0,
    checkpointCount: 0,
    ...(hookMsPerRequest === undefined
      ? {}
      : { sink: { batches: 1, intervals: 1, endpoints: 1, requests: 4000, rejected: 0, hookMsPerRequest } }),
  };
}

function reportOf(rounds: RoundResult[]): BenchReport {
  return {
    generatedAt: "2026-09-29T00:00:00.000Z",
    node: "v24.0.0",
    platform: "linux-x64",
    host: { cores: 4, memoryMb: 16384, cpu: "Neoverse-N1" },
    subject: {
      agentPath: "packages/agent/src/register.ts",
      version: "0.9.0",
      commit: "479e5c6000000000000000000000000000000000",
      dirty: false,
      source: "working-tree",
    },
    config: {
      rounds: 1,
      warmupCleanSec: 3,
      warmupMaxSec: 30,
      measureSec: 20,
      rps: RPS,
      seed: 1,
      agentPath: "/x/register.ts",
    },
    rounds,
    metrics: [
      {
        metric: "cpuPct",
        unit: "pp",
        method: "median-of-rounds",
        baselineMedian: 10,
        agentMedian: 12.907,
        delta: 2.907,
        excess: -0.093,
        noise: 0,
        budget: 3,
        status: "ok",
        resolved: true,
      },
    ],
    verdict: "pass",
  };
}

const evidence = reportOf([roundOf("baseline", 10), roundOf("agent", 12.907, HOOK_MS)]);

function readingOf(report: BenchReport): ProfileReading {
  return {
    kind: "profile",
    generatedAt: report.generatedAt,
    node: report.node,
    platform: report.platform,
    config: { rounds: 1, measureSec: 20, rps: RPS, seed: 1 },
    baseline: { ok: false, reason: "not profiled in this test" },
    agent: { ok: false, reason: "not profiled in this test" },
    hooks: hooksOf(report),
  };
}

describe("the hooks block of a profile run (DT-21)", () => {
  it("puts the estimate inside the hooks in points of one core: ms per request × rps / 10", () => {
    // A point of one core is 10 ms of CPU per second: 0.0342 ms × 200 requests a second is 6.84 ms a second,
    // 0.684 pp — not the 0.007 a division by 1000 gave, which is the fraction of a core.
    expect(hooksOf(evidence)).toEqual({
      hookMsPerRequest: 0.0342,
      insideHooksPp: 0.684,
      deltaCpuPp: 2.907,
      outsideHooksPp: 2.223,
    });
  });

  it("agrees with the campaign's own reading of the same numbers", () => {
    // hooksShare reads the campaign's report with measuredMs = Δpp × 10 / rps: both say about 24 %.
    expect(hooksShare(evidence)).toContain("about 24 % of the measured cost is inside the hooks");
    expect(profileMarkdown(readingOf(evidence))).toContain(
      "which is 0.684 pp of one core at 200 rps, against +2.907 pp measured over the pairs — about 24 % of the " +
        "measured cost inside the hooks; +2.223 pp runs outside them.",
    );
  });

  it("says there is no line when no pair was measured", () => {
    expect(hooksOf(reportOf([roundOf("agent", 12.907, HOOK_MS)]))).toEqual({
      reason: "no measured pair: the estimate has nothing to stand beside",
    });
  });

  it("says only the measured side when the agent's rounds carried no estimate", () => {
    const hooks = hooksOf(reportOf([roundOf("baseline", 10), roundOf("agent", 12.907)]));
    expect(hooks.deltaCpuPp).toBe(2.907);
    expect(hooks.insideHooksPp).toBeUndefined();
    expect(hooks.reason).toContain("did not report their own hook estimate");
  });
});
