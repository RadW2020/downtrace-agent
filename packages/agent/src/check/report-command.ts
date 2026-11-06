import { resolve } from "node:path";
import { CALLS_PER_REQUEST_BOUNDARIES_V0 } from "@downtrace/protocol";
import {
  type FileReport,
  type InspectionFailure,
  LINES_NAMED,
  readInspection,
  UNPROFILED_IN_FILE,
} from "./inspection.ts";
import type { CompositionKind, OperationTally, RouteTally, RunTally } from "./read.ts";
import { fmt, plural } from "./render.ts";
import { tallyNotes } from "./run.ts";

/**
 * `downtrace report <file>`: what each route of an application ran, from a file `DOWNTRACE_INSPECT` wrote. The value
 * that needs no account and no tests: start the application with `DOWNTRACE_INSPECT`, use it, read the report.
 *
 * For each route: its requests, how many queries a request ran — the mean, over the requests a profile covers, as
 * `check` divides them, and the median, from the protocol's buckets of calls per request — the operations a request
 * ran more than once, and the slowest. Routes with the most queries per request come first: the route that runs a
 * query once per row is the one to read first. Nothing here is a verdict; a single file has nothing to compare with.
 */

/** Part of the contract with whoever reads the JSON: a change that breaks a reader moves this number. */
export const ROUTE_REPORT_SCHEMA = "downtrace-report/1";

/** How many of a route's slowest operations are named. */
export const SLOWEST = 3;

/** A bucket of queries per request, as the protocol counts them: `from` to `to`, and `to` null for «more than». */
export interface QueriesBucket {
  from: number;
  to: number | null;
}

export interface OperationSummary {
  /** Stable: the kind and the fingerprint, as `check` names it. */
  id: string;
  kind: CompositionKind;
  /** The protocol's fingerprint; null where several were folded into one (a call to this machine, on any port). */
  hash: string | null;
  /** What it is called, when the text travelled. */
  label: string | null;
  /** Executions per request, over the requests a profile covers; null when a profile covers none. */
  perRequest: number | null;
  executions: number;
  msPerExecution: number | null;
}

export interface RouteSummary {
  /** `POST /checkout`: the method and the template. */
  id: string;
  method: string;
  route: string;
  requests: number;
  /** Of those, the requests whose composition is known: what the executions are divided by. */
  profiledRequests: number;
  queriesPerRequest: {
    /** The mean, over the requests a profile covers; null when a profile covers none. */
    mean: number | null;
    /** The bucket the median request falls in. Null when no request was counted, or when `severalDatabases`. */
    median: QueriesBucket | null;
    /**
     * Its requests reached more than one database in an interval: each database counts its own queries per request,
     * and how many one request ran in all is not in the file, so there is no median.
     */
    severalDatabases: boolean;
  };
  /** The operations a request ran more than once, the most repeated first. */
  repeated: OperationSummary[];
  /** The operations that took longest per execution, the slowest first, `SLOWEST` at most. */
  slowest: OperationSummary[];
  /** The mean duration of a request, in milliseconds; null when no request was counted. */
  meanRequestMs: number | null;
}

export interface RouteReport {
  schema: typeof ROUTE_REPORT_SCHEMA;
  /** `failed` is «the file could not be read as one DOWNTRACE_INSPECT wrote»: no report was made. */
  status: "reported" | "failed";
  file: FileReport | null;
  /** By queries per request, most first. */
  routes: RouteSummary[];
  failure: InspectionFailure | null;
  notes: string[];
}

/** The bucket of index `index`, from the protocol's boundaries: 0, 1, 2, 3 to 5, …, 21 to 50, more than 50. */
function bucket(index: number): QueriesBucket {
  const previous = CALLS_PER_REQUEST_BOUNDARIES_V0[index - 1];
  return { from: previous === undefined ? 0 : previous + 1, to: CALLS_PER_REQUEST_BOUNDARIES_V0[index] ?? null };
}

/** The bucket the median request falls in: the lower median, the one at half the requests, rounded up. */
export function medianBucket(buckets: readonly number[] | null): QueriesBucket | null {
  if (buckets === null) return null;
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const half = Math.ceil(total / 2);
  let seen = 0;
  for (const [index, n] of buckets.entries()) {
    seen += n;
    if (seen >= half) return bucket(index);
  }
  return null;
}

function operationOf(operation: OperationTally, profiledRequests: number): OperationSummary {
  return {
    id: operation.id,
    kind: operation.kind,
    hash: operation.hash ?? null,
    label: operation.label ?? null,
    perRequest: profiledRequests === 0 ? null : operation.executions / profiledRequests,
    executions: operation.executions,
    msPerExecution: operation.executions === 0 ? null : operation.totalMs / operation.executions,
  };
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function summarizeRoute(route: RouteTally): RouteSummary {
  const operations = [...route.operations.values()].map((operation) => operationOf(operation, route.profiledRequests));
  const queries = [...route.operations.values()]
    .filter((operation) => operation.kind === "query")
    .reduce((sum, operation) => sum + operation.executions, 0);
  return {
    id: route.id,
    method: route.method,
    route: route.route,
    requests: route.requests,
    profiledRequests: route.profiledRequests,
    queriesPerRequest: {
      mean: route.profiledRequests === 0 ? null : queries / route.profiledRequests,
      median: medianBucket(route.queriesPerRequest),
      severalDatabases: route.queriesPerRequest === null,
    },
    // More than once per request on average means at least one request ran it more than once.
    repeated: operations
      .filter((operation) => (operation.perRequest ?? 0) > 1)
      .sort((a, b) => (b.perRequest ?? 0) - (a.perRequest ?? 0) || byId(a, b)),
    slowest: operations
      .filter((operation) => operation.msPerExecution !== null)
      .sort((a, b) => (b.msPerExecution ?? 0) - (a.msPerExecution ?? 0) || byId(a, b))
      .slice(0, SLOWEST),
    meanRequestMs: route.requests === 0 ? null : route.durationMs / route.requests,
  };
}

/** Every route of the file, the most queries per request first; the routes no profile covers last. */
export function summarizeRoutes(tally: RunTally): RouteSummary[] {
  const rank = (route: RouteSummary): number => route.queriesPerRequest.mean ?? -1;
  return [...tally.routes.values()]
    .map(summarizeRoute)
    .sort((a, b) => rank(b) - rank(a) || b.requests - a.requests || byId(a, b));
}

// --- the text -----------------------------------------------------------------------------------------------

function bucketText(range: QueriesBucket): string {
  if (range.to === null) return `more than ${range.from - 1}`;
  return range.from === range.to ? String(range.from) : `${range.from} to ${range.to}`;
}

function queriesText(route: RouteSummary): string {
  const { mean, median, severalDatabases } = route.queriesPerRequest;
  const medianText =
    median !== null
      ? `median ${bucketText(median)}`
      : severalDatabases
        ? "median not known: its requests reached more than one database"
        : undefined;
  if (mean === null) {
    return `queries per request not known: no profile covered its requests${medianText === undefined ? "" : `; ${medianText}`}`;
  }
  const word = fmt(mean) === "1" ? "query" : "queries";
  return `${fmt(mean)} ${word} per request on average${medianText === undefined ? "" : `, ${medianText}`}`;
}

function operationLine(tag: string, operation: OperationSummary, counts: string): string {
  const name = operation.label ?? "(no text travelled)";
  const identity = operation.hash === null ? operation.id : `${operation.kind} ${operation.hash}`;
  return `    ${tag.padEnd(10)} ${name}  [${identity}]  ${counts}`;
}

/** A duration as a person reads it: what rounds to nothing and was not nothing is said as such. */
function msText(ms: number): string {
  return ms > 0 && fmt(ms) === "0" ? "under 0.01 ms" : `${fmt(ms)} ms`;
}

function perRequestText(operation: OperationSummary): string {
  return operation.perRequest === null ? "per request not known" : `${fmt(operation.perRequest)} per request`;
}

/** The lines that could not be read, by number: all of them, or the first ones when there were more. */
export function linesText(file: FileReport): string {
  const listed = file.unreadLines.join(", ");
  if (file.unreadLines.length < LINES_NAMED) return `line${file.unreadLines.length === 1 ? "" : "s"} ${listed}`;
  return `lines ${listed} and more`;
}

/** The head of a file: what wrote it and what it holds. */
export function fileLine(file: FileReport): string {
  const unread = file.unreadLines.length === 0 ? "" : `  ·  left out: ${linesText(file)}`;
  return (
    `${plural(file.requests, "request")} on ${plural(file.routes, "route")}, ` +
    `${plural(file.processes, "process", "processes")} wrote ${plural(file.batches, "batch", "batches")}${unread}`
  );
}

/** The report as a person reads it. */
export function renderReportText(report: RouteReport): string {
  const out: string[] = [];
  if (report.status === "failed" || report.file === null) {
    out.push("downtrace report: no report could be made", "");
    if (report.failure !== null) {
      out.push(`  ${report.failure.message}`);
      if (report.failure.advice !== null) out.push("", `  ${report.failure.advice}`);
    }
    for (const note of report.notes) out.push("", note);
    return `${out.join("\n")}\n`;
  }
  out.push(`downtrace report: ${report.file.file}`, `  ${fileLine(report.file)}`, "");
  out.push(`By queries per request, most first (${report.routes.length})`);
  for (const route of report.routes) {
    out.push(`  ${route.id}   ${plural(route.requests, "request")}  ·  ${queriesText(route)}`);
    for (const operation of route.repeated) out.push(operationLine("repeated", operation, perRequestText(operation)));
    for (const operation of route.slowest) {
      const ms = operation.msPerExecution === null ? "" : `${msText(operation.msPerExecution)} per execution, `;
      out.push(operationLine("slowest", operation, `${ms}${perRequestText(operation)}`));
    }
    if (route.meanRequestMs !== null) out.push(`    request duration: ${fmt(route.meanRequestMs)} ms on average`);
  }
  for (const note of report.notes) out.push("", note);
  return `${out.join("\n")}\n`;
}

/** The report as a coding agent reads it. */
export function renderReportJson(report: RouteReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// --- the command --------------------------------------------------------------------------------------------

function failedReport(failure: InspectionFailure): RouteReport {
  return { schema: ROUTE_REPORT_SCHEMA, status: "failed", file: null, routes: [], failure, notes: [] };
}

/**
 * Reads the file, says the report on `stdout` — the text, or the JSON — and returns the exit status: 0 a report was
 * made, 2 the file could not be read as one `DOWNTRACE_INSPECT` wrote.
 */
export async function runReport(options: {
  file: string;
  cwd: string;
  json: boolean;
  /** The packages the project where the command runs depends on: what says an observer should have found a driver. */
  dependencies: ReadonlySet<string> | undefined;
  stdout: (text: string) => void;
}): Promise<number> {
  const read = await readInspection(resolve(options.cwd, options.file), options.file);
  if (!read.ok) {
    const report = failedReport(read.failure);
    options.stdout(options.json ? renderReportJson(report) : renderReportText(report));
    return 2;
  }
  const { tally, report: file } = read.inspection;
  const report: RouteReport = {
    schema: ROUTE_REPORT_SCHEMA,
    status: "reported",
    file,
    routes: summarizeRoutes(tally),
    failure: null,
    notes: tallyNotes(
      tally,
      { on: "", side: options.file, file: options.file, unprofiled: UNPROFILED_IN_FILE },
      options.dependencies,
    ),
  };
  options.stdout(options.json ? renderReportJson(report) : renderReportText(report));
  return 0;
}
