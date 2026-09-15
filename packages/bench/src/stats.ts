import { mulberry32 } from "./prng.ts";

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile over an ascending-sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function median(values: readonly number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    50,
  );
}

/** Percentile over the union of several sample arrays (the "pooled" estimate). */
export function pooledPercentile(groups: readonly (readonly number[])[], p: number): number {
  const all: number[] = [];
  for (const g of groups) for (const v of g) all.push(v);
  all.sort((a, b) => a - b);
  return percentile(all, p);
}

/**
 * Split-half noise: shuffle the pooled samples with a seeded PRNG, split them in
 * two halves, take |p(A) − p(B)|; repeat and keep the maximum. It measures how
 * much the percentile moves between two equally sized draws of the same thing.
 */
export function splitHalfNoise(samples: readonly number[], p: number, iterations = 20, seed = 7): number {
  if (samples.length < 4) return 0;
  const rand = mulberry32(seed);
  const arr = [...samples];
  let worst = 0;
  for (let it = 0; it < iterations; it++) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = arr[i] as number;
      arr[i] = arr[j] as number;
      arr[j] = t;
    }
    const half = Math.floor(arr.length / 2);
    const a = arr.slice(0, half).sort((x, y) => x - y);
    const b = arr.slice(half, half * 2).sort((x, y) => x - y);
    worst = Math.max(worst, Math.abs(percentile(a, p) - percentile(b, p)));
  }
  return worst;
}

/**
 * Two-sided 97.5 % quantiles of Student's t by degrees of freedom (1..30); beyond thirty, the last tabulated value,
 * which is never less conservative than the table and has no jump in it. A table and not a dependency: the bench
 * has none, and thirty numbers are cheaper than a library.
 */
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
  2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function tQuantile975(degreesOfFreedom: number): number {
  if (degreesOfFreedom < 1) return Number.POSITIVE_INFINITY;
  return T_975[Math.min(degreesOfFreedom, T_975.length) - 1] ?? 2.042;
}

/** Sample standard deviation (n − 1). */
export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

/**
 * How much the machine itself moves between identical rounds, as the error it puts on a difference of two
 * medians — not as the range of the rounds (gh-571, ADR 0137).
 *
 * `t(n−1) · sd(baseline rounds) · √(2/n)`: the baseline rounds are the machine measuring the same thing n times,
 * their standard deviation is its drift, `√(2/n)` is what that drift does to a difference of two medians each
 * taken over n rounds, and Student's t says honestly that three rounds resolve little (4.30 × the standard error)
 * where nine resolve more (2.31 ×). A range never shrinks when a round is added and grows with the count of
 * rounds by construction, so with it the documented answer to a large noise — more rounds — made the noise
 * larger. This one shrinks with √n, which is what a measurement repeated n times is supposed to do.
 *
 * Only the baseline goes in, deliberately: an agent round that goes wild is what the corroboration rule of
 * ADR 0010/0111 exists for, and letting it inflate the noise would turn every measured regression with one bad
 * round into `inconclusive`. Infinite below two rounds: one round cannot estimate its own drift.
 */
export function roundDrift(baselineRounds: readonly number[]): number {
  const n = baselineRounds.length;
  if (n < 2) return Number.POSITIVE_INFINITY;
  return tQuantile975(n - 1) * standardDeviation(baselineRounds) * Math.sqrt(2 / n);
}

export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
