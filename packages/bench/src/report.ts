import { appendFile, writeFile } from "node:fs/promises";
import type { LoadReport } from "./load.ts";
import type { ResourceUsage } from "./process-sampler.ts";
import type { SinkStats } from "./sink.ts";
import type { MetricVerdict, Verdict } from "./verdict.ts";

export type Variant = "baseline" | "agent";

export interface RoundResult {
  round: number;
  variant: Variant;
  load: LoadReport;
  usage: ResourceUsage;
  /** What the cloud stand-in received; only for the agent variant. */
  sink?: SinkStats | undefined;
}

export interface BenchConfig {
  rounds: number;
  warmupSec: number;
  measureSec: number;
  rps: number;
  seed: number;
  agentPath: string;
}

export interface BenchReport {
  generatedAt: string;
  node: string;
  platform: string;
  config: BenchConfig;
  rounds: RoundResult[];
  metrics: MetricVerdict[];
  verdict: Verdict;
}

const ICON: Record<MetricVerdict["status"], string> = { ok: "✅", fail: "❌", inconclusive: "⚠️" };

export function toMarkdown(r: BenchReport): string {
  const lines = [
    `### Agent overhead benchmark — **${r.verdict.toUpperCase()}**`,
    "",
    `${r.config.rounds} rounds/variant · ${r.config.rps} rps · ${r.config.measureSec}s measured (+${r.config.warmupSec}s warmup) · seed ${r.config.seed} · ${r.node} ${r.platform}`,
    `Agent shipped ${totalBatches(r)} batch(es) to the sink across its rounds.`,
    "",
    "| Metric | Baseline (median) | Agent (median) | Δ | Noise | Budget | |",
    "|---|---:|---:|---:|---:|---:|:-:|",
    ...r.metrics.map(
      (m) =>
        `| ${m.metric} (${m.unit}) | ${m.baselineMedian} | ${m.agentMedian} | ${m.delta >= 0 ? "+" : ""}${m.delta} | ${m.noise} | ≤ ${m.budget} | ${ICON[m.status]} ${m.status} |`,
    ),
    "",
    "<details><summary>Rounds</summary>",
    "",
    "| Round | Variant | p50 | p95 | p99 | max | errors | rps | CPU % | RSS max MiB | ELU | batches |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...r.rounds.map(
      (x) =>
        `| ${x.round} | ${x.variant} | ${x.load.overall.p50} | ${x.load.overall.p95} | ${x.load.overall.p99} | ${x.load.overall.max} | ${x.load.errors} | ${x.load.achievedRps} | ${x.usage.cpuPct.toFixed(1)} | ${x.usage.rssMaxMb.toFixed(1)} | ${x.usage.elu.toFixed(2)} | ${x.sink ? x.sink.batches : "—"} |`,
    ),
    "",
    "</details>",
    "",
  ];
  return lines.join("\n");
}

function totalBatches(r: BenchReport): number {
  return r.rounds.reduce((n, x) => n + (x.sink?.batches ?? 0), 0);
}

export async function writeJson(report: BenchReport, path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

/** Appends the Markdown to GitHub's job summary when running in Actions. */
export async function appendStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  await appendFile(path, `${markdown}\n`);
  return true;
}
