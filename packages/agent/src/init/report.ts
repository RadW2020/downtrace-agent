import type { PackageManager } from "./detect.ts";

/**
 * What `downtrace init` hands back: text for a person, and with `--json` one object a coding agent can branch on.
 * The codes are stable; the messages are for reading.
 */

export const INIT_SCHEMA = "downtrace-init/1";

/** What could not be detected or done, each with what to do instead. Init writes what it could, and ends with 1. */
export const MISSING_CODES = [
  "no-package-json",
  "no-framework",
  "no-test-command",
  "not-a-repository",
  "not-installed",
  "instrumentation-exists",
  "module-resolution",
] as const;
export type MissingCode = (typeof MISSING_CODES)[number];

/** A file init needs could not be read as it should be. Init writes nothing, and ends with 2. */
export const INIT_FAILURE_CODES = ["bad-package-json", "bad-config", "io-error"] as const;
export type InitFailureCode = (typeof INIT_FAILURE_CODES)[number];

export type FileAction = "created" | "updated" | "unchanged";

export interface Missing {
  code: MissingCode;
  message: string;
  advice: string;
}

export interface InitFailure {
  code: InitFailureCode;
  message: string;
  advice: string;
}

export interface Detected {
  packageManager: PackageManager;
  frameworks: string[];
  observed: string[];
  testScript: string | null;
  testCommand: string | null;
  bundler: "next-standalone" | null;
}

export interface InitReport {
  schema: typeof INIT_SCHEMA;
  status: "configured" | "incomplete" | "failed";
  /** The directory init looked at. */
  project: string;
  /** Null when there was nothing to look at: no `package.json`, or one that could not be read. */
  detected: Detected | null;
  /** The command `check` runs now, from `downtrace.json`: the one init wrote, or the one a person had put there. */
  command: string | null;
  files: Array<{ path: string; action: FileAction }>;
  missing: Missing[];
  failure: InitFailure | null;
  /** What to run next, spelled for whether the project has this package installed. */
  next: string | null;
}

export function exitCodeOfInit(report: InitReport): number {
  if (report.status === "configured") return 0;
  return report.status === "incomplete" ? 1 : 2;
}

export function renderInitJson(report: InitReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** The report as text: what it found, what it wrote, what is left to do and what to run next. */
export function renderInitText(report: InitReport): string {
  const lines: string[] = [];
  if (report.failure !== null) {
    lines.push(`downtrace init: nothing was written in ${report.project}`, "");
    lines.push(`  ${report.failure.message}`, `  ${report.failure.advice}`);
    return `${lines.join("\n")}\n`;
  }

  const todo = report.missing.length;
  lines.push(
    report.status === "configured"
      ? `downtrace init: configured ${report.project}`
      : `downtrace init: not configured yet in ${report.project}: ${todo} ${todo === 1 ? "thing" : "things"} to do`,
  );

  const found = report.detected;
  if (found !== null) {
    const row = (name: string, value: string): string => `  ${name.padEnd(14)}${value}`;
    lines.push("");
    lines.push(
      row("framework", found.frameworks.length > 0 ? found.frameworks.join(", ") : "none it names routes for"),
    );
    lines.push(row("observed", [...found.observed, "outgoing HTTP"].join(", ")));
    lines.push(row("test script", found.testScript ?? "none found"));
    if (found.bundler === "next-standalone") lines.push(row("build", 'Next.js with output: "standalone"'));
    lines.push(row("check runs", report.command ?? "nothing yet"));
  }

  if (report.files.length > 0) {
    lines.push("");
    for (const file of report.files) lines.push(`  ${file.action.padEnd(10)}${file.path}`);
  }

  if (todo > 0) {
    lines.push("", "To do:");
    for (const item of report.missing) lines.push(`  - ${item.message}.`, `    ${item.advice}`);
  }

  if (report.next !== null) lines.push("", `Next: ${report.next}`);
  return `${lines.join("\n")}\n`;
}
