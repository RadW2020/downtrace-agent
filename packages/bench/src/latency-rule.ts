import { median } from "./stats.ts";

export type MetricStatus = "ok" | "fail" | "inconclusive";

export interface LatencyRuleInput {
  /** p99 of every baseline sample pooled, and the same for the agent. */
  pooledBaseline: number;
  pooledAgent: number;
  /** Sampling noise of the baseline pool, estimated by splitting it in halves. */
  splitHalfNoise: number;
  /** p99 of each round, in order, per variant. */
  baselineRounds: readonly number[];
  agentRounds: readonly number[];
  budget: number;
}

export interface LatencyRuleResult {
  delta: number;
  noise: number;
  /** Which estimate the noise came from, so the report can say why it is that big. */
  noiseSource: "split-half" | "round-spread";
  status: MetricStatus;
  /** Δ of each agent round against the baseline rounds' median. */
  roundDeltas: number[];
  /** How many agent rounds corroborate the pooled difference, out of how many. */
  corroborating: number;
  rounds: number;
  /** Present when corroboration, not the numbers, is what withheld a fail. */
  reason?: string;
}

/**
 * Decides the latency metric from numbers only: same input, same verdict, so a CI run can be replayed in a test
 * from the figures in its own report.
 *
 * Two things separate it from a plain "delta beats budget and noise" (ADR 0010):
 *
 * - **Noise** is the larger of the split-half estimate and the spread of the baseline's per-round p99s. The first
 *   measures sampling variation inside the pool; the second measures the runner drifting between rounds, which
 *   alternating rounds only cancel in part. Estimating only the first claims a precision the machine does not have.
 * - **Corroboration**: a fail also requires most agent rounds to show the difference. One round stalling for 200 ms
 *   queues enough requests to drag a pooled p99 on its own; a real regression shows up in round after round.
 */
export function latencyStatus(input: LatencyRuleInput): LatencyRuleResult {
  const delta = input.pooledAgent - input.pooledBaseline;
  const spread =
    input.baselineRounds.length > 0 ? Math.max(...input.baselineRounds) - Math.min(...input.baselineRounds) : 0;
  const noise = Math.max(input.splitHalfNoise, spread);
  const noiseSource = spread > input.splitHalfNoise ? "round-spread" : "split-half";

  const baselineTypical = input.baselineRounds.length > 0 ? median(input.baselineRounds) : input.pooledBaseline;
  const roundDeltas = input.agentRounds.map((p99) => p99 - baselineTypical);
  const rounds = roundDeltas.length;
  // Half the pooled difference: a round that carries less than that is not what the pooled number is made of.
  const threshold = delta / 2;
  const corroborating = roundDeltas.filter((d) => d >= threshold).length;
  const majority = Math.floor(rounds / 2) + 1;

  const base = { delta, noise, noiseSource, roundDeltas, corroborating, rounds } as const;
  if (delta <= input.budget) return { ...base, status: "ok" };
  if (delta <= noise) return { ...base, status: "inconclusive" };
  if (rounds > 0 && corroborating < majority) {
    return {
      ...base,
      status: "inconclusive",
      reason: `one round dominates the tail (${corroborating}/${rounds} rounds corroborate)`,
    };
  }
  return { ...base, status: "fail" };
}
