import type { RouteResult, Summary } from "./compare.ts";
import { summarize } from "./compare.ts";

/**
 * What `check` hands back: the same object for a person (rendered as text), for a coding agent (`--json`) and
 * for CI (the exit status), so that the three never disagree about what happened (invariant 13).
 */

/** Part of the contract with whoever reads the JSON: a change that breaks a reader moves this number. */
export const REPORT_SCHEMA = "downtrace-check/1";

/** Why no comparison was made. Stable: an agent branches on these. */
export const FAILURE_CODES = [
  "not-a-repository",
  "bad-ref",
  "bad-config",
  "no-command",
  "setup-failed",
  "command-failed",
  "timeout",
  "no-profile",
  "nothing-evaluated",
  "interrupted",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export type Side = "base" | "change";

/** What one of the two runs was, and what it left. */
export interface SideReport {
  /** The ref it ran at, or `working tree`. */
  ref: string;
  /** The commit: the base's, or the one the working tree is on. */
  commit: string | null;
  command: string;
  /** The exit status of the test command; null when it was killed. */
  exitCode: number | null;
  durationMs: number;
  /** Processes that wrote at least one batch. */
  processes: number;
  batches: number;
  requests: number;
  /** Routes that served at least one request. */
  routes: number;
  profileWindows: number;
  /** Lines of the file that could not be read. */
  malformed: number;
  /** What the instrumentation said it observed, by driver. */
  observers: Record<string, string>;
}

export interface Failure {
  code: FailureCode;
  side: Side | null;
  message: string;
  /** What to do about it, when there is something. */
  advice: string | null;
  /** The last of the test command's output, when it is what failed. */
  outputTail: string | null;
}

export interface CheckReport {
  schema: typeof REPORT_SCHEMA;
  /** `failed` is «no comparison could be made», which is never the same as «nothing got worse». */
  status: "compared" | "failed";
  summary: Summary | null;
  routes: RouteResult[];
  base: SideReport | null;
  change: SideReport | null;
  failure: Failure | null;
  /** What the reader should keep in mind about this comparison. */
  notes: string[];
}

/** The note that is always there: durations are data. */
export const DURATIONS_NOTE =
  "Durations are shown and never judged: the traffic of a test run is not production's and the machine it runs " +
  "on is not quiet. Only composition decides a verdict.";

export function compared(parts: {
  base: SideReport;
  change: SideReport;
  routes: RouteResult[];
  notes: string[];
}): CheckReport {
  return {
    schema: REPORT_SCHEMA,
    status: "compared",
    summary: summarize(parts.routes),
    routes: parts.routes,
    base: parts.base,
    change: parts.change,
    failure: null,
    notes: [DURATIONS_NOTE, ...parts.notes],
  };
}

export function failed(parts: {
  failure: Failure;
  base?: SideReport | null;
  change?: SideReport | null;
  routes?: RouteResult[];
  notes?: string[];
}): CheckReport {
  const routes = parts.routes ?? [];
  return {
    schema: REPORT_SCHEMA,
    status: "failed",
    summary: routes.length > 0 ? summarize(routes) : null,
    routes,
    base: parts.base ?? null,
    change: parts.change ?? null,
    failure: parts.failure,
    notes: parts.notes ?? [],
  };
}

/** The exit status: 0 nothing got worse, 1 something did, 2 there was no comparison. */
export function exitCodeOf(report: CheckReport): 0 | 1 | 2 {
  if (report.status === "failed") return 2;
  return (report.summary?.worse ?? 0) > 0 ? 1 : 0;
}
