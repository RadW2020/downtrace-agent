import { resolve } from "node:path";
import type { RouteResult, Summary } from "./compare.ts";
import { summarize } from "./compare.ts";
import {
  type FileReport,
  INSPECTION_FAILURES,
  type InspectionFailure,
  readInspection,
  UNPROFILED_IN_FILE,
} from "./inspection.ts";
import { notEvaluatedLines, verdictLines } from "./render.ts";
import { DURATIONS_NOTE, exitCodeOf, type Side } from "./report.ts";
import { fileLine } from "./report-command.ts";
import { judge } from "./run.ts";

/**
 * `downtrace compare <base> <change>`: `check`'s verdict over two files `DOWNTRACE_INSPECT` wrote, recorded however the
 * project can — its end-to-end suite run on the base branch and on this one, the application used by hand before and
 * after — so that `check` does not have to run the tests twice in a checkout of its own.
 *
 * The verdict is `check`'s, from the same code (`judge` in `run.ts`): route by route, by composition and never by
 * latency, nothing presented as unchanged that was not evaluated, and the same exit status. What differs is only
 * where the two tallies come from, and so what a side is: a file, with no command, no commit and no exit status.
 */

/** Part of the contract with whoever reads the JSON: a change that breaks a reader moves this number. */
export const COMPARE_SCHEMA = "downtrace-compare/1";

/** Why no comparison was made. Stable: an agent branches on these. */
export const COMPARE_FAILURES = [...INSPECTION_FAILURES, "nothing-evaluated"] as const;
export type CompareFailureCode = (typeof COMPARE_FAILURES)[number];

export interface CompareFailure {
  code: CompareFailureCode;
  /** The file it is about; null when it is about both. */
  side: Side | null;
  message: string;
  advice: string | null;
  /** The line of that file it is about, from 1; null when it is about the whole file. */
  line: number | null;
}

export interface CompareReport {
  schema: typeof COMPARE_SCHEMA;
  /** `failed` is «no comparison could be made», which is never the same as «nothing got worse». */
  status: "compared" | "failed";
  summary: Summary | null;
  /** The same routes, with the same verdicts, as `check` hands back. */
  routes: RouteResult[];
  base: FileReport | null;
  change: FileReport | null;
  failure: CompareFailure | null;
  notes: string[];
}

function failedCompare(
  failure: CompareFailure,
  parts: { base?: FileReport | null; change?: FileReport | null; routes?: RouteResult[] } = {},
): CompareReport {
  const routes = parts.routes ?? [];
  return {
    schema: COMPARE_SCHEMA,
    status: "failed",
    summary: routes.length > 0 ? summarize(routes) : null,
    routes,
    base: parts.base ?? null,
    change: parts.change ?? null,
    failure,
    notes: [],
  };
}

function sideLine(name: string, file: FileReport | null): string {
  return `  ${name.padEnd(7)}${file === null ? "not read" : `${file.file}  ·  ${fileLine(file)}`}`;
}

/** The comparison as a person reads it: the two files, then the verdicts in `check`'s words. */
export function renderCompareText(report: CompareReport): string {
  const out: string[] = [];
  if (report.status === "failed" && report.failure !== null) {
    const { failure } = report;
    out.push("downtrace compare: no comparison could be made", "");
    out.push(`  ${failure.side === null ? "" : `${failure.side}: `}${failure.message}`);
    if (failure.advice !== null) out.push("", `  ${failure.advice}`);
    if (report.base !== null || report.change !== null) {
      out.push("", sideLine("base", report.base), sideLine("change", report.change));
    }
    out.push(...notEvaluatedLines(report.routes));
    for (const note of report.notes) out.push("", note);
    return `${out.join("\n")}\n`;
  }
  out.push(
    `downtrace compare: ${report.change?.file ?? "the change"} against ${report.base?.file ?? "the base"}`,
    "",
    sideLine("base", report.base),
    sideLine("change", report.change),
    "",
    ...verdictLines(report.summary, report.routes),
  );
  for (const note of report.notes) out.push("", note);
  return `${out.join("\n")}\n`;
}

export function renderCompareJson(report: CompareReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** A file that could not be read, said with the side it is. */
function sideFailure(side: Side, failure: InspectionFailure): CompareFailure {
  return { code: failure.code, side, message: failure.message, advice: failure.advice, line: failure.line };
}

/**
 * Reads the two files, judges them as `check` judges its runs, says the result on `stdout` — the text, or the JSON —
 * and returns `check`'s exit status: 0 no route got worse, 1 at least one did, 2 no comparison could be made.
 */
export async function runCompare(options: {
  base: string;
  change: string;
  cwd: string;
  json: boolean;
  /** The packages the project where the command runs depends on: what says an observer should have found a driver. */
  dependencies: ReadonlySet<string> | undefined;
  stdout: (text: string) => void;
}): Promise<number> {
  const say = (report: CompareReport): number => {
    options.stdout(options.json ? renderCompareJson(report) : renderCompareText(report));
    return exitCodeOf(report);
  };
  const base = await readInspection(resolve(options.cwd, options.base), options.base);
  if (!base.ok) return say(failedCompare(sideFailure("base", base.failure)));
  const change = await readInspection(resolve(options.cwd, options.change), options.change);
  if (!change.ok) {
    return say(failedCompare(sideFailure("change", change.failure), { base: base.inspection.report }));
  }

  const files = { base: options.base, change: options.change };
  const judged = judge(
    { base: base.inspection.tally, change: change.inspection.tally },
    {
      declared: [],
      dependencies: options.dependencies,
      wording: { side: files, file: files, unprofiled: UNPROFILED_IN_FILE },
    },
  );
  const sides = { base: base.inspection.report, change: change.inspection.report };
  if (judged.failure !== null) {
    const { code, message, advice } = judged.failure;
    return say(failedCompare({ code, side: null, message, advice, line: null }, { ...sides, routes: judged.routes }));
  }
  return say({
    schema: COMPARE_SCHEMA,
    status: "compared",
    summary: summarize(judged.routes),
    routes: judged.routes,
    ...sides,
    failure: null,
    notes: [DURATIONS_NOTE, ...judged.notes],
  });
}
