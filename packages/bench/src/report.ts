import { appendFile, writeFile } from "node:fs/promises";
import type { LoadReport } from "./load.ts";
import type { PoolWait, ResourceUsage } from "./process-sampler.ts";
import type { SinkStats } from "./sink.ts";
import type { MetricVerdict, Verdict } from "./verdict.ts";
import type { WarmupResult } from "./warmup.ts";

export type Variant = "baseline" | "agent";

export interface RoundResult {
  round: number;
  variant: Variant;
  /** How long the app was warmed before measuring, and whether it got clean. */
  warmup: WarmupResult;
  load: LoadReport;
  usage: ResourceUsage;
  /**
   * Milliseconds requests spent waiting for a database connection during the measured window, summed across
   * routes. A round that ran out of connections shows it here instead of only as a 5000 ms p99 someone has to read
   * as a symptom (gh-177).
   */
  poolWait: PoolWait;
  /** CPU used by everything that is not this benchmark, as a percentage of one core. Absent where unreadable. */
  otherCpuPct: number | undefined;
  /** Milliseconds the database spent writing checkpoints during the window, and how many ran. */
  checkpointWriteMs: number | undefined;
  checkpointCount: number | undefined;
  /** First distinct error lines the app wrote to stderr during the round; only present when there were errors. */
  firstErrors?: readonly string[] | undefined;
  /** What the cloud stand-in received; only for the agent variant. */
  sink?: SinkStats | undefined;
}

export interface BenchConfig {
  rounds: number;
  /** Consecutive error-free seconds of load required before each round is measured. */
  warmupCleanSec: number;
  /** Upper bound on warmup; a round that is not clean by then is not measured. */
  warmupMaxSec: number;
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
  /** Why the verdict was overridden (request errors in rounds), when it was. */
  reason?: string | undefined;
}

const ICON: Record<MetricVerdict["status"], string> = { ok: "✅", fail: "❌", inconclusive: "⚠️" };

export function toMarkdown(r: BenchReport): string {
  const lines = [
    `### Agent overhead benchmark — **${r.verdict.toUpperCase()}**`,
    "",
    `${r.config.rounds} rounds/variant · ${r.config.rps} rps · ${r.config.measureSec}s measured (after ${r.config.warmupCleanSec}s clean warmup, max ${r.config.warmupMaxSec}s) · seed ${r.config.seed} · ${r.node} ${r.platform}`,
    `Agent shipped ${totalBatches(r)} batch(es) to the sink across its rounds.`,
    ...(r.reason ? ["", `**${r.reason}**`] : []),
    "",
    // The margin is in the table because it is the number the verdict rests on: a Δ that dwarfs the noise says
    // nothing about whether the budget is crossed, and reading Δ against the noise is what got that wrong before
    // (ADR 0030).
    "| Metric | Baseline | Agent | Δ | Over budget | Noise | Budget | |",
    "|---|---:|---:|---:|---:|---:|---:|:-:|",
    ...r.metrics.map(
      (m) =>
        `| ${m.metric} (${m.unit}${m.method === "pooled-p99" ? `, pooled n=${m.samples}` : ", median of rounds"}) | ${m.baselineMedian} | ${m.agentMedian} | ${m.delta >= 0 ? "+" : ""}${m.delta} | ${m.excess > 0 ? `+${m.excess}` : "—"} | ${m.noise}${m.noiseSource ? ` (${m.noiseSource})` : ""} | ≤ ${m.budget} | ${ICON[m.status]} ${m.status}${m.reason ? ` — ${m.reason}` : ""} |`,
    ),
    "",
    "<details><summary>Rounds</summary>",
    "",
    "| Round | Variant | warmup s | p50 | p95 | p99 | Δ p99 | max | errors | rps | CPU % | RSS max MiB | ELU | other CPU % | checkpoints | worst pool wait | batches |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...r.rounds.map(
      (x, i) =>
        `| ${x.round} | ${x.variant} | ${x.warmup.seconds} | ${x.load.overall.p50} | ${x.load.overall.p95} | ${x.load.overall.p99} | ${roundDelta(r, i)} | ${x.load.overall.max} | ${x.load.errors} | ${x.load.achievedRps} | ${x.usage.cpuPct.toFixed(1)} | ${x.usage.rssMaxMb.toFixed(1)} | ${x.usage.elu.toFixed(2)} | ${x.otherCpuPct === undefined ? "?" : x.otherCpuPct.toFixed(1)} | ${checkpointCell(x)} | ${poolWaitCell(x.poolWait)} | ${x.sink ? x.sink.batches : "—"} |`,
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

/** Raw latency samples stay in memory; the JSON report carries the derived numbers only. */
export async function writeJson(report: BenchReport, path: string): Promise<void> {
  const slim = { ...report, rounds: report.rounds.map((r) => ({ ...r, load: { ...r.load, samples: undefined } })) };
  await writeFile(path, `${JSON.stringify(slim, null, 2)}\n`);
}

/** Appends the Markdown to GitHub's job summary when running in Actions. */
export async function appendStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  await appendFile(path, `${markdown}\n`);
  return true;
}

/** Δ of an agent round against the baseline rounds' median, as the latency rule saw it. Blank for baseline rounds. */
/**
 * The worst single wait and the second it happened, so the round can be lined up with the database's own log.
 * An em dash rather than "0 ms" when nothing waited: a zero with a timestamp would read as a measurement (gh-177).
 */
export function poolWaitCell(wait: PoolWait): string {
  if (wait.maxMs <= 0 || wait.maxAt === undefined) return "—";
  const at = new Date(wait.maxAt).toISOString().slice(11, 19);
  return `${Math.round(wait.maxMs)} ms @ ${at} (${Math.round(wait.totalMs)} total)`;
}

/**
 * What the database wrote during the round. A question mark where the counters could not be read, because not
 * knowing is not a quiet database (gh-194).
 */
export function checkpointCell(r: {
  checkpointCount: number | undefined;
  checkpointWriteMs: number | undefined;
}): string {
  if (r.checkpointCount === undefined || r.checkpointWriteMs === undefined) return "?";
  if (r.checkpointCount === 0) return "none";
  return `${r.checkpointCount} · ${(r.checkpointWriteMs / 1000).toFixed(1)} s writing`;
}

function roundDelta(r: BenchReport, index: number): string {
  const round = r.rounds[index];
  if (!round || round.variant !== "agent") return "—";
  const deltas = r.metrics.find((m) => m.metric === "p99Ms")?.roundDeltas;
  const agentIndex = r.rounds.slice(0, index + 1).filter((x) => x.variant === "agent").length - 1;
  const d = deltas?.[agentIndex];
  return d === undefined ? "—" : `${d >= 0 ? "+" : ""}${d}`;
}
