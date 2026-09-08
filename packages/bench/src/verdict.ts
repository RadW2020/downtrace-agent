import { BUDGET, METRICS, type MetricName, UNITS } from "./budget.ts";
import { type LatencyRuleResult, latencyStatus } from "./latency-rule.ts";
import { median, percentile, pooledPercentile, round, splitHalfNoise } from "./stats.ts";

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
  /** How far over the budget the delta is; negative when it is under. What the verdict rests on (ADR 0030). */
  excess: number;
  noise: number;
  /** Which estimate the noise came from; only meaningful for the pooled latency metric. */
  noiseSource?: "split-half" | "round-spread" | undefined;
  budget: number;
  status: MetricStatus;
  /** Δ of each agent round against the baseline rounds' median; pooled latency only. */
  roundDeltas?: number[] | undefined;
  /** Why a fail was withheld, when corroboration is what decided it. */
  reason?: string | undefined;
}

export interface LatencyPools {
  /** One array of latency samples per baseline round. */
  baseline: readonly (readonly number[])[];
  agent: readonly (readonly number[])[];
  /** Seed for the split-half shuffle; fixed so the noise estimate is reproducible. */
  seed?: number | undefined;
}

/**
 * Latency (p99Ms), when pools are given: the p99 of ALL samples of a variant (5 × 2400 → decided by ~120 values
 * instead of ~24), with the noise and corroboration rule of `latencyStatus` (ADR 0010). Otherwise, and for CPU/RSS
 * always:
 * delta  = median(agent) − median(baseline)
 * noise  = max(baseline) − min(baseline): how much the machine itself moves between identical runs
 * ok            delta ≤ budget
 * fail          delta − budget > noise   (the excess over the budget is distinguishable from noise)
 * inconclusive  delta > budget but the excess is within the noise (this machine cannot resolve the budget)
 *
 * It is the **excess** that has to clear the noise, not delta (ADR 0030). Comparing delta with the noise asks
 * whether the overhead exists, which nobody is asking and which is always true for a metric whose delta dwarfs
 * its noise: CPU sat at ~3 pp against a noise under 1, so that comparison could only ever say "fail".
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
    let rule: LatencyRuleResult | undefined;
    if (pooled) {
      baselineMedian = pooledPercentile(latency.baseline, 99);
      agentMedian = pooledPercentile(latency.agent, 99);
      const pool = latency.baseline.flat();
      const p99Of = (round: readonly number[]) =>
        percentile(
          [...round].sort((a, b) => a - b),
          99,
        );
      rule = latencyStatus({
        pooledBaseline: baselineMedian,
        pooledAgent: agentMedian,
        splitHalfNoise: splitHalfNoise(pool, 99, 20, latency.seed ?? 7),
        baselineRounds: latency.baseline.map(p99Of),
        agentRounds: latency.agent.map(p99Of),
        budget: budget[metric],
      });
      noise = rule.noise;
      samples = pool.length;
    } else {
      const b = baseline.map((r) => r[metric]);
      baselineMedian = median(b);
      agentMedian = median(agent.map((r) => r[metric]));
      noise = Math.max(...b) - Math.min(...b);
    }
    const delta = agentMedian - baselineMedian;
    const excess = delta - budget[metric];
    const status: MetricStatus = rule?.status ?? (excess <= 0 ? "ok" : excess > noise ? "fail" : "inconclusive");
    return {
      metric,
      unit: UNITS[metric],
      method: pooled ? "pooled-p99" : "median-of-rounds",
      samples,
      baselineMedian: round(baselineMedian, 3),
      agentMedian: round(agentMedian, 3),
      delta: round(delta, 3),
      /** How far over the budget it is. This is the number the verdict rests on (ADR 0030). */
      excess: round(excess, 3),
      noise: round(noise, 3),
      noiseSource: rule?.noiseSource,
      budget: budget[metric],
      status,
      roundDeltas: rule?.roundDeltas.map((d) => round(d, 3)),
      reason: rule?.reason,
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

/** What one round delivered to the sink, for the check below. */
export interface RoundDelivery {
  variant: "baseline" | "agent";
  round: number;
  /** Batches the sink received, or undefined for a round that had no sink. */
  batches?: number | undefined;
}

/**
 * A round that had a sink and delivered nothing to it was not a measurement of an agent shipping: it was a
 * measurement of an agent posting into the void. The overhead of aggregating, serializing and sending is exactly
 * what the budget is about, so a run where none of that arrived cannot produce a verdict about it (gh-134).
 *
 * Any round with a sink, not only the agent's: with `baselineEnv` the baseline is another agent configuration and
 * ships too, and a paired comparison where one side delivered nothing is as broken as one where the other did
 * (gh-152). A round without a sink says nothing about delivery and is left alone.
 *
 * Only "delivered nothing at all" counts. How many batches a round should produce depends on the interval and the
 * length of the round, and guessing a minimum here would turn a timing detail into a red.
 */
export function applyUndeliveredBatches(
  verdict: Verdict,
  reason: string | undefined,
  rounds: readonly RoundDelivery[],
): { verdict: Verdict; reason?: string } {
  const silent = rounds.filter((r) => r.batches === 0);
  // Nothing to say: keep the verdict exactly as it was, key and all (exactOptionalPropertyTypes).
  if (silent.length === 0) return reason === undefined ? { verdict } : { verdict, reason };
  const which = silent.map((r) => `${r.variant}#${r.round}`).join(", ");
  const said = `rounds delivered no batches to the sink (${which}): nothing was measured about shipping`;
  return { verdict: "fail", reason: reason ? `${reason} · ${said}` : said };
}

/** What one round saw of the machine outside this benchmark. */
export interface RoundNeighbour {
  round: number;
  variant: "baseline" | "agent";
  /** CPU used by everything that is not this benchmark, as a percentage of one core. Absent where unreadable. */
  otherCpuPct: number | undefined;
}

/**
 * How far apart two halves of a pair may be in neighbour CPU before they stop being a comparison.
 *
 * The rounds alternate precisely so that each pair sees the same machine. Twenty points of a core is more than
 * any of this benchmark's own effects and less than what one CI job on the neighbouring runner costs, which is
 * the difference the rule has to tell apart (gh-200).
 */
const NEIGHBOUR_TOLERANCE_PCT = 20;

/**
 * Downgrades a verdict to `inconclusive` when a pair's two halves did not see the same machine.
 *
 * Never upgrades and never downgrades a `fail`: a guardrail a busy neighbour can switch off is not a guardrail.
 * And a pair where the machine could not be read is left alone — not knowing is not the same as detecting.
 */
export function applyNeighbourCpu(
  verdict: Verdict,
  reason: string | undefined,
  rounds: readonly RoundNeighbour[],
): { verdict: Verdict; reason?: string } {
  const keep = reason === undefined ? { verdict } : { verdict, reason };
  if (verdict === "fail") return keep;
  const byRound = new Map<number, Partial<Record<"baseline" | "agent", number>>>();
  for (const r of rounds) {
    if (r.otherCpuPct === undefined) continue;
    const pair = byRound.get(r.round) ?? {};
    pair[r.variant] = r.otherCpuPct;
    byRound.set(r.round, pair);
  }
  const uneven: number[] = [];
  for (const [round, pair] of [...byRound].sort(([a], [b]) => a - b)) {
    const { baseline, agent } = pair;
    if (baseline === undefined || agent === undefined) continue;
    if (Math.abs(agent - baseline) > NEIGHBOUR_TOLERANCE_PCT) uneven.push(round);
  }
  if (uneven.length === 0) return keep;
  const said =
    `rounds ${uneven.join(", ")} did not see the same machine in both halves: something else on this host used ` +
    `the CPU during one of them, so the pair is not a comparison`;
  return { verdict: "inconclusive", reason: reason ? `${reason} · ${said}` : said };
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
