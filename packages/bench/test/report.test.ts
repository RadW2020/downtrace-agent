import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendStepSummary, type BenchReport, toMarkdown } from "../src/report.ts";

const report: BenchReport = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  node: "v24.0.0",
  platform: "linux-x64",
  config: {
    rounds: 1,
    warmupCleanSec: 1,
    warmupMaxSec: 30,
    measureSec: 2,
    rps: 100,
    seed: 1,
    agentPath: "/x/register.ts",
  },
  rounds: [
    {
      round: 1,
      variant: "baseline",
      warmup: { seconds: 1, clean: true, lastErrors: 0 },
      load: {
        targetRps: 100,
        achievedRps: 99.5,
        requested: 200,
        completed: 200,
        errors: 0,
        elapsedMs: 2010,
        overall: { p50: 2, p95: 4, p99: 6, max: 9 },
        byEndpoint: {},
        samples: [],
      },
      usage: { cpuPct: 12.3, rssMaxMb: 80.2, elu: 0.41 },
    },
    {
      round: 1,
      variant: "agent",
      warmup: { seconds: 4, clean: true, lastErrors: 0 },
      load: {
        targetRps: 100,
        achievedRps: 99.4,
        requested: 200,
        completed: 200,
        errors: 0,
        elapsedMs: 2012,
        overall: { p50: 2, p95: 4, p99: 6.4, max: 9 },
        byEndpoint: {},
        samples: [],
      },
      usage: { cpuPct: 12.5, rssMaxMb: 81, elu: 0.42 },
      sink: { batches: 2, intervals: 2, endpoints: 8, requests: 400, rejected: 0 },
    },
  ],
  metrics: [
    {
      metric: "p99Ms",
      unit: "ms",
      method: "pooled-p99",
      samples: 12000,
      baselineMedian: 6,
      agentMedian: 6.4,
      delta: 0.4,
      noise: 0,
      budget: 1,
      status: "ok",
    },
    {
      metric: "cpuPct",
      unit: "pp",
      method: "median-of-rounds",
      baselineMedian: 12.3,
      agentMedian: 12.5,
      delta: 0.2,
      noise: 0,
      budget: 3,
      status: "ok",
    },
    {
      metric: "rssMb",
      unit: "MiB",
      method: "median-of-rounds",
      baselineMedian: 80.2,
      agentMedian: 81,
      delta: 0.8,
      noise: 0,
      budget: 64,
      status: "ok",
    },
  ],
  verdict: "pass",
};

describe("report", () => {
  it("renders a markdown table with one row per metric and per round", () => {
    const md = toMarkdown(report);
    expect(md).toContain("**PASS**");
    expect(md).toContain("| p99Ms (ms, pooled n=12000) | 6 | 6.4 | +0.4 | 0 | ≤ 1 | ✅ ok |");
    expect(md).toContain("| cpuPct (pp, median of rounds) |");
    expect(md).toContain("| 1 | baseline | 1 | 2 | 4 | 6 | — | 9 | 0 | 99.5 | 12.3 | 80.2 | 0.41 | — |");
    expect(md).toContain("| 1 | agent | 4 | 2 | 4 | 6.4 | — | 9 | 0 | 99.4 | 12.5 | 81.0 | 0.42 | 2 |");
    expect(md).toContain("Agent shipped 2 batch(es)");
  });

  it("appends to GITHUB_STEP_SUMMARY when set, and does nothing otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-"));
    const file = join(dir, "summary.md");
    expect(await appendStepSummary("hello", {})).toBe(false);
    expect(await appendStepSummary("hello", { GITHUB_STEP_SUMMARY: file })).toBe(true);
    expect(await appendStepSummary("world", { GITHUB_STEP_SUMMARY: file })).toBe(true);
    expect(await readFile(file, "utf8")).toBe("hello\nworld\n");
  });
});
