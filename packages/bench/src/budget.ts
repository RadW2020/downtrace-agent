/**
 * Executable form of invariant 3 (docs/invariants.md): what the agent may add on top of the same app
 * without it.
 *
 * Checked **after a merge and never before one**, on a machine of its own: the benchmark left the pipeline
 * when it turned out to be measuring the other CI jobs on the same VM (ADR 0032), and now measures in the
 * public mirror, where the runner is free, `aarch64` and has nothing else on it (ADR 0134). The tests that
 * assert a rate or a duration are still launched by hand (ADR 0114). So a change that doubles what the
 * instrumentation costs does get in — nothing is gated on this — but it no longer gets in unmeasured.
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
