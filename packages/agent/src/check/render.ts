import type { DependencyResult, OperationResult, RouteResult } from "./compare.ts";
import type { CheckReport, SideReport } from "./report.ts";

/** A number as a person reads it: whole when it is whole, two decimals at most when it is not. */
export function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

const KIND_LABEL: Record<DependencyResult["kind"], string> = {
  query: "queries",
  call: "outgoing calls",
  command: "Redis commands",
};

const MOVED: Record<OperationResult["change"], string> = {
  appeared: "appeared",
  multiplied: "multiplied",
  unchanged: "same",
  reduced: "reduced",
  disappeared: "gone",
};

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function side(name: string, report: SideReport | null): string {
  if (report === null) return `  ${name.padEnd(7)}not run`;
  const seconds = `${fmt(report.durationMs / 1000)} s`;
  return (
    `  ${name.padEnd(7)}${report.command}  ·  exit ${report.exitCode ?? "none"}  ·  ${seconds}  ·  ` +
    `${plural(report.requests, "request")} on ${plural(report.routes, "route")}, ` +
    `${plural(report.processes, "process", "processes")} wrote`
  );
}

function operationLine(operation: OperationResult): string {
  const name = operation.label ?? "(no text travelled)";
  const identity = operation.hash === null ? operation.id : `${operation.kind} ${operation.hash}`;
  const counts = `${fmt(operation.perRequest.base)} -> ${fmt(operation.perRequest.change)} per request`;
  return `    ${MOVED[operation.change].padEnd(10)} ${name}  [${identity}]  ${counts}`;
}

function dependencyPart(dependency: DependencyResult): string {
  const { base, change } = dependency.perRequest;
  const counts = base === change ? `${fmt(base)}` : `${fmt(base)} -> ${fmt(change)}`;
  return `${KIND_LABEL[dependency.kind]} ${counts} per request`;
}

function durationLine(route: RouteResult): string | undefined {
  const { base, change } = route.meanRequestMs;
  if (base === null || change === null) return undefined;
  return `    request duration, shown and not judged: ${fmt(base)} ms -> ${fmt(change)} ms`;
}

function requestsLine(route: RouteResult): string {
  const { requests, profiledRequests } = route;
  const partial =
    profiledRequests.base < requests.base || profiledRequests.change < requests.change
      ? ` (profiled: ${profiledRequests.base} and ${profiledRequests.change})`
      : "";
  return `${requests.base} requests in the base, ${requests.change} in the change${partial}`;
}

function evaluatedBlock(route: RouteResult): string[] {
  const lines = [`  ${route.id}   ${requestsLine(route)}`];
  const moved = route.operations.filter((operation) => operation.change !== "unchanged");
  for (const operation of moved) lines.push(operationLine(operation));
  const rest = route.dependencies.filter((dependency) => !dependency.worse);
  if (rest.length > 0) {
    const verdict = route.verdict === "worse" ? "did not get worse: " : "";
    lines.push(`    ${verdict}${rest.map(dependencyPart).join(" · ")}`);
  } else if (route.verdict === "unchanged" && route.dependencies.length > 0) {
    lines.push(`    ${route.dependencies.map(dependencyPart).join(" · ")}`);
  }
  const duration = durationLine(route);
  if (duration !== undefined) lines.push(duration);
  return lines;
}

/** The report as a person reads it: three columns, and what was left out said by name. */
export function renderText(report: CheckReport): string {
  const out: string[] = [];
  if (report.status === "failed" && report.failure !== null) {
    const { failure } = report;
    out.push("downtrace check: no comparison could be made", "");
    out.push(`  ${failure.side === null ? "" : `${failure.side}: `}${failure.message}`);
    if (failure.advice !== null) out.push("", `  ${failure.advice}`);
    if (report.base !== null || report.change !== null)
      out.push("", side("base", report.base), side("change", report.change));
    if (failure.outputTail !== null && failure.outputTail !== "") {
      out.push("", `Last output of the ${failure.side ?? "test"} run:`);
      for (const line of failure.outputTail.split("\n")) out.push(`  ${line}`);
    }
    for (const note of report.notes) out.push("", note);
    return `${out.join("\n")}\n`;
  }

  const summary = report.summary ?? { worse: 0, unchanged: 0, notEvaluated: 0 };
  out.push(
    `downtrace check: ${report.change?.ref ?? "working tree"} against ${report.base?.ref ?? "the base"}` +
      `${report.base?.commit ? ` (${report.base.commit.slice(0, 9)})` : ""}`,
    "",
    side("base", report.base),
    side("change", report.change),
    "",
  );
  const evaluated = summary.worse + summary.unchanged;
  out.push(
    `${evaluated} of ${evaluated + summary.notEvaluated} routes evaluated: ${summary.worse} worse, ${summary.unchanged} unchanged.`,
  );

  const worse = report.routes.filter((route) => route.verdict === "worse");
  const unchanged = report.routes.filter((route) => route.verdict === "unchanged");
  const skipped = report.routes.filter((route) => route.verdict === "not-evaluated");
  if (worse.length > 0) {
    out.push("", `Worse (${worse.length})`);
    for (const route of worse) out.push(...evaluatedBlock(route));
  }
  if (unchanged.length > 0) {
    out.push("", `Unchanged (${unchanged.length})`);
    for (const route of unchanged) out.push(...evaluatedBlock(route));
  }
  if (skipped.length > 0) {
    out.push("", `Not evaluated (${skipped.length})`);
    for (const route of skipped) {
      out.push(`  ${route.id}`);
      for (const reason of route.reasons) out.push(`    ${reason.message}`);
    }
  }
  for (const note of report.notes) out.push("", note);
  return `${out.join("\n")}\n`;
}

/** The report as a coding agent reads it. */
export function renderJson(report: CheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
