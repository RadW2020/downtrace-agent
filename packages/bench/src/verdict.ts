import { BUDGET, METRICS, type MetricName, UNITS } from "./budget.ts";
import { median, pooledPercentile, round, splitHalfNoise } from "./stats.ts";

export type RoundMetrics = Record<MetricName, number>;
export type MetricStatus = "ok" | "fail" | "inconclusive";
export type Verdict = "pass" | "fail" | "inconclusive";

export interface MetricVerdict {
  metric: MetricName;
  unit: string;
  /** How the two values were obtained: per-round medians, or one percentile over all pooled samples. */
  method: "median-of-rounds" | "pooled-p99";
  /** Samples behind each pooled value (per variant); absent for median-of-rounds. */
  samples?: number | undefined;
  baselineMedian: number;
  agentMedian: number;
  delta: number;
  noise: number;
  budget: number;
  status: MetricStatus;
}

export interface LatencyPools {
  /** One array of latency samples per baseline round. */
  baseline: readonly (readonly number[])[];
  agent: readonly (readonly number[])[];
  /** Seed for the split-half shuffle; fixed so the noise estimate is reproducible. */
  seed?: number | undefined;
}

/**
 * Latency (p99Ms), when pools are given: the p99 of ALL samples of a variant
 * (5 × 2400 → decided by ~120 values instead of ~24), and noise = split-half
 * spread of the baseline pool. Otherwise, and for CPU/RSS always:
 * delta  = median(agent) − median(baseline)
 * noise  = max(baseline) − min(baseline): how much the machine itself moves between identical runs
 * ok            delta ≤ budget
 * fail          delta > budget and delta > noise   (the excess is distinguishable from noise)
 * inconclusive  delta > budget but delta ≤ noise   (this machine cannot resolve the budget)
 */
export function evaluate(
  baseline: RoundMetrics[],
  agent: RoundMetrics[],
  budget: Record<MetricName, number> = BUDGET,
  latency?: LatencyPools,
): { metrics: MetricVerdict[]; verdict: Verdict } {
  if (baseline.length === 0 || agent.length === 0) throw new Error("evaluate: need at least one round per variant");
  const metrics = METRICS.map((metric): MetricVerdict => {
    const pooled = metric === "p99Ms" && latency !== undefined;
    let baselineMedian: number;
    let agentMedian: number;
    let noise: number;
    let samples: number | undefined;
    if (pooled) {
      baselineMedian = pooledPercentile(latency.baseline, 99);
      agentMedian = pooledPercentile(latency.agent, 99);
      const pool = latency.baseline.flat();
      noise = splitHalfNoise(pool, 99, 20, latency.seed ?? 7);
      samples = pool.length;
    } else {
      const b = baseline.map((r) => r[metric]);
      baselineMedian = median(b);
      agentMedian = median(agent.map((r) => r[metric]));
      noise = Math.max(...b) - Math.min(...b);
    }
    const delta = agentMedian - baselineMedian;
    const status: MetricStatus = delta <= budget[metric] ? "ok" : delta > noise ? "fail" : "inconclusive";
    return {
      metric,
      unit: UNITS[metric],
      method: pooled ? "pooled-p99" : "median-of-rounds",
      samples,
      baselineMedian: round(baselineMedian, 3),
      agentMedian: round(agentMedian, 3),
      delta: round(delta, 3),
      noise: round(noise, 3),
      budget: budget[metric],
      status,
    };
  });
  const verdict: Verdict = metrics.some((m) => m.status === "fail")
    ? "fail"
    : metrics.some((m) => m.status === "inconclusive")
      ? "inconclusive"
      : "pass";
  return { metrics, verdict };
}

export interface RoundErrors {
  variant: "baseline" | "agent";
  round: number;
  errors: number;
  errorStatuses?: Record<string, number> | undefined;
  /** What the application itself said went wrong (first distinct stderr error lines). */
  firstErrors?: readonly string[] | undefined;
}

export function describeStatuses(statuses: Record<string, number> | undefined): string {
  return Object.entries(statuses ?? {})
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
}

function describeApp(firstErrors: readonly string[] | undefined): string {
  return firstErrors && firstErrors.length > 0 ? ` — app: ${firstErrors.join(" | ")}` : "";
}

export interface WarmupOutcome {
  variant: "baseline" | "agent";
  round: number;
  seconds: number;
  lastErrors: number;
  lastErrorStatuses?: Record<string, number> | undefined;
  firstErrors?: readonly string[] | undefined;
}

/**
 * The application never strung enough clean seconds together during warmup, so
 * the round was not measured. Same rule as request errors in measured rounds:
 * the agent variant breaking the app is a fail; the baseline breaking on its own
 * means nothing could be measured.
 */
export function warmupVerdict(w: WarmupOutcome): { verdict: Verdict; reason: string } {
  const detail = `${w.variant}#${w.round}: app not clean after ${w.seconds} s of warmup — last second: ${w.lastErrors} failed (${describeStatuses(w.lastErrorStatuses)})${describeApp(w.firstErrors)}`;
  return w.variant === "agent"
    ? { verdict: "fail", reason: `agent round could not warm up — ${detail}` }
    : { verdict: "inconclusive", reason: `baseline round could not warm up, nothing can be measured — ${detail}` };
}

/**
 * A benchmark is only as good as its data. Failed requests in agent rounds mean
 * the agent breaks the application: fail. Failed requests in baseline rounds
 * mean the machine could not run the reference app cleanly: nothing can be
 * measured, so the result is inconclusive — never a pass by accident.
 */
export function applyRoundErrors(
  verdict: Verdict,
  rounds: readonly RoundErrors[],
): { verdict: Verdict; reason?: string } {
  const describe = (r: RoundErrors) =>
    `${r.variant}#${r.round}: ${r.errors} failed (${describeStatuses(r.errorStatuses)})${describeApp(r.firstErrors)}`;
  const agentBad = rounds.filter((r) => r.variant === "agent" && r.errors > 0);
  if (agentBad.length > 0)
    return { verdict: "fail", reason: `agent rounds had request errors — ${agentBad.map(describe).join("; ")}` };
  const baseBad = rounds.filter((r) => r.variant === "baseline" && r.errors > 0);
  if (baseBad.length > 0 && verdict !== "fail") {
    return {
      verdict: "inconclusive",
      reason: `baseline rounds had request errors, nothing can be measured — ${baseBad.map(describe).join("; ")}`,
    };
  }
  return { verdict };
}

/** A round the benchmark could not measure at all, with the verdict it forces. */
export interface Aborted {
  verdict: Verdict;
  reason: string;
}

/**
 * A round that could not be measured never rescues a `fail` that the measured rounds already earned: if either
 * says `fail`, the benchmark fails and the report carries both reasons. Otherwise the abort wins, because from
 * that round on nothing was measured.
 */
export function combineWithAbort(
  measured: { verdict: Verdict; reason?: string },
  aborted: Aborted | undefined,
): { verdict: Verdict; reason?: string } {
  if (!aborted) return measured;
  if (measured.verdict !== "fail") return aborted;
  const measuredReason = measured.reason ?? "the rounds that were measured exceeded the overhead budget";
  return { verdict: "fail", reason: `${measuredReason} · ${aborted.reason}` };
}
