import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * How a kept report is named and described on the mirror's `bench-reports` branch (ADR 0134).
 *
 * The name and the message come out of the report itself: composed from the workflow's variables they would
 * describe the run and not the measurement, and those are not the same thing. The name sorts chronologically
 * and carries the version and the commit, so two runs can be found and compared; an `instruments` report is
 * named apart from the campaigns so the series stays a series (gh-570).
 *
 * This used to be a `node -e` script inside the workflow's YAML, where nothing ran it before the mirror did, and
 * an illegal `return` cost the series a point (gh-590). Now it is a module a test runs, and a script the workflow
 * calls.
 */

interface Subject {
  version?: string | undefined;
  commit?: string | undefined;
  sourceCommit?: string | undefined;
}

interface CampaignReport {
  kind?: undefined;
  generatedAt: string;
  subject?: Subject | undefined;
  config: { rounds: number; measureSec: number; rps: number };
  verdict: string;
  reason?: string | undefined;
  metrics: { metric: string; delta: number; unit: string; budget: number; noise: number; status: string }[];
}

interface InstrumentsReport {
  kind: "instruments";
  generatedAt: string;
  subject?: Subject | undefined;
  config: { rounds: number; measureSec: number; rps: number };
  steps: { name: string; cpuPp: number; cpuNoise2se: number; p: number; resolved: boolean }[];
}

interface CoexistenceReport {
  kind: "coexistence";
  generatedAt: string;
  subject?: Subject | undefined;
  config: { rounds: number; measureSec: number; rps: number };
  /** The tracker's cost, per metric: no budget, no verdict — what is reported, not what is judged (ESC-16). */
  metrics: { metric: string; delta: number; unit: string; noise: number; p: number; resolved: boolean }[];
  /** The agent's own hook estimate in the two configurations; undefined when no round was measured. */
  hook?:
    | { baseline?: number | undefined; agent?: number | undefined; p?: number | undefined; resolved: boolean }
    | undefined;
  reason?: string | undefined;
}

interface ProfileSideJson {
  ok: boolean;
  reason?: string | undefined;
  totalMs?: number | undefined;
  samples?: number | undefined;
  groups?: { group: string; selfMs: number }[] | undefined;
  top?: { function: string; group: string; selfMs: number }[] | undefined;
}

interface ProfileReport {
  kind: "profile";
  generatedAt: string;
  subject?: Subject | undefined;
  config: { rounds: number; measureSec: number; rps: number };
  /** A reading of a pair, not a verdict (gh-592): the round's CPU by function, in the two configurations. */
  baseline: ProfileSideJson;
  agent: ProfileSideJson;
  reason?: string | undefined;
}

export type KeptReport = CampaignReport | InstrumentsReport | CoexistenceReport | ProfileReport;

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

function identity(r: KeptReport): { stamp: string; version: string; commit: string } {
  return {
    stamp: r.generatedAt.replace(/:/g, "-").replace(/\.\d+Z$/, "Z"),
    version: r.subject?.version ?? "unknown",
    commit: (r.subject?.sourceCommit ?? r.subject?.commit ?? "unknown").slice(0, 7),
  };
}

export function reportFileName(r: KeptReport): string {
  const { stamp, version, commit } = identity(r);
  if (r.kind === "instruments") return `${stamp}-instruments-${version}-${commit}.json`;
  if (r.kind === "coexistence") return `${stamp}-coexistence-${version}-${commit}.json`;
  if (r.kind === "profile") return `${stamp}-profile-${version}-${commit}.json`;
  return `${stamp}-agent-${version}-${commit}.json`;
}

export function reportMessage(r: KeptReport): string {
  const { version } = identity(r);
  const where = `on ${r.config.rounds}×${r.config.measureSec}s at ${r.config.rps} rps`;
  if (r.kind === "instruments") {
    const resolved = r.steps.filter((s) => s.resolved).length;
    const step = (s: InstrumentsReport["steps"][number]) =>
      `${s.name}: ΔCPU ${signed(s.cpuPp)} pp ± ${s.cpuNoise2se} (p ${s.p}) ${s.resolved ? "resolved" : "not resolved"}`;
    return `bench-instruments: agent ${version} — ${resolved} of ${r.steps.length} resolved ${where}\n\n${r.steps.map(step).join("\n")}\n\n`;
  }
  if (r.kind === "coexistence") {
    const metric = (m: CoexistenceReport["metrics"][number]) =>
      `${m.metric} ${signed(m.delta)} ${m.unit} (noise ${m.noise}, p ${m.p}) ${m.resolved ? "resolved" : "not resolved"}`;
    const hook = r.hook
      ? `\nhook estimate ${r.hook.baseline ?? "—"} → ${r.hook.agent ?? "—"} ms/request (p ${r.hook.p ?? "—"}, ${r.hook.resolved ? "resolved" : "not resolved"})\n`
      : "";
    return (
      `bench-coexistence: agent ${version} — what the tracker costs beside it ${where}\n\n` +
      `${r.metrics.map(metric).join("\n")}\n${hook}${r.reason ? `\n${r.reason}\n` : ""}\n`
    );
  }
  if (r.kind === "profile") {
    // The reading of a pair, named like the others so the series stays a series: how much CPU each side's
    // profile held, the sources they split it over, and the top of the side that carries the agent.
    const side = (s: ProfileSideJson): string =>
      s.ok ? `${s.totalMs} ms in ${s.samples} samples` : (s.reason ?? "not read");
    const groups =
      r.agent.ok && r.baseline.ok && r.agent.groups !== undefined && r.baseline.groups !== undefined
        ? r.agent.groups
            .map((g) => {
              const b = r.baseline.groups?.find((x) => x.group === g.group);
              return `${g.group} ${b?.selfMs ?? "—"} → ${g.selfMs} ms`;
            })
            .join("\n")
        : "";
    // The top of the side that carries the agent: the baseline's top, without it, is not the reading.
    const top =
      r.agent.ok && r.agent.top !== undefined
        ? r.agent.top
            .slice(0, 5)
            .map((f) => `${f.function} (${f.group}) ${f.selfMs} ms`)
            .join("\n")
        : "";
    return (
      `bench-profile: agent ${version} — what runs outside the hooks, read by function ${where}\n\n` +
      `baseline: ${side(r.baseline)}\nagent: ${side(r.agent)}\n` +
      (groups !== "" ? `\n${groups}\n` : "") +
      (top !== "" ? `\ntop of the ${r.agent.ok ? "agent" : "baseline"} side:\n${top}\n` : "") +
      `${r.reason ? `\n${r.reason}\n` : ""}\n`
    );
  }
  const metric = (m: CampaignReport["metrics"][number]) =>
    `${m.metric} ${signed(m.delta)} ${m.unit} (budget ${m.budget}, noise ${m.noise}) ${m.status}`;
  return (
    `bench: agent ${version} — ${r.verdict} ${where}\n\n${r.metrics.map(metric).join("\n")}\n` +
    `${r.reason ? `\n${r.reason}\n` : ""}\n`
  );
}

// As a script: `node report-name.ts <report.json> <message-path>` writes the message and prints the name.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [reportPath, messagePath] = process.argv.slice(2);
  if (!reportPath || !messagePath) {
    console.error("usage: report-name.ts <report.json> <message-path>");
    process.exit(2);
  }
  // Parsed as unknown and narrowed by shape: the report is this package's own output, but the file is input.
  const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as KeptReport;
  writeFileSync(messagePath, reportMessage(parsed));
  console.log(reportFileName(parsed));
}
