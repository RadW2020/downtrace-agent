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

export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
