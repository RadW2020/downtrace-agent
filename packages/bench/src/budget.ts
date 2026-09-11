/**
 * Executable form of invariant 3 (docs/invariants.md): what the agent may add on top of the same app
 * without it.
 *
 * Checked by running `make bench` on a quiet machine, **not on every change**: the benchmark left the
 * pipeline when it turned out to be measuring the other CI jobs on the same VM (ADR 0032), and the tests
 * that assert a rate or a duration left with it (ADR 0114). Until something brings it back, a change that
 * doubles what the instrumentation costs gets in without anything going red.
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
