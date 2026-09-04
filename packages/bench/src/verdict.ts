import { BUDGET, METRICS, type MetricName, UNITS } from "./budget.ts";
import { median, round } from "./stats.ts";

export type RoundMetrics = Record<MetricName, number>;
export type MetricStatus = "ok" | "fail" | "inconclusive";
export type Verdict = "pass" | "fail" | "inconclusive";

export interface MetricVerdict {
  metric: MetricName;
  unit: string;
  baselineMedian: number;
  agentMedian: number;
  delta: number;
  noise: number;
  budget: number;
  status: MetricStatus;
}

/**
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
): { metrics: MetricVerdict[]; verdict: Verdict } {
  if (baseline.length === 0 || agent.length === 0) throw new Error("evaluate: need at least one round per variant");
  const metrics = METRICS.map((metric): MetricVerdict => {
    const b = baseline.map((r) => r[metric]);
    const a = agent.map((r) => r[metric]);
    const baselineMedian = median(b);
    const agentMedian = median(a);
    const delta = agentMedian - baselineMedian;
    const noise = Math.max(...b) - Math.min(...b);
    const status: MetricStatus = delta <= budget[metric] ? "ok" : delta > noise ? "fail" : "inconclusive";
    return {
      metric,
      unit: UNITS[metric],
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
