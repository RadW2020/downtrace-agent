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

export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
