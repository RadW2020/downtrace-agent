/**
 * Executable form of invariant 3 (docs/invariants.md): what the agent may add
 * on top of the same app without it. Enforced by `make bench` in CI.
 */
export const BUDGET = {
  /** Added latency at p99, in milliseconds. */
  p99Ms: 1,
  /** Added CPU, in percentage points of the app process. */
  cpuPct: 3,
  /** Added peak RSS, in MiB. */
  rssMb: 64,
} as const;

export type MetricName = keyof typeof BUDGET;
export const METRICS = Object.keys(BUDGET) as MetricName[];
export const UNITS: Record<MetricName, string> = { p99Ms: "ms", cpuPct: "pp", rssMb: "MiB" };
