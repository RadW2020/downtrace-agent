import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./bench.ts";
import { type ProfileFunction, type ProfileGroupTotal, readCpuProfiles } from "./cpu-profile.ts";
import type { BenchReport } from "./report.ts";
import { round } from "./stats.ts";

/**
 * What runs outside the hooks, read by function (gh-592).
 *
 * One B/A pair under the load of the benchmark, both halves with `--cpu-prof`: the profile of a round is the
 * round's CPU by frame, and the difference between the two halves is what the agent adds to it — the work that
 * the hook estimate (ADR 0080) does not see, because it is not in the hooks. The reading is by function, as the
 * ticket says it is enough: a table of where the CPU sat, grouped by what the source is, and the top functions
 * of the agent's side.
 *
 * It is **not** a verdict: a profile of one pair says what that pair ran, and it is kept as a reading, the way
 * the instruments and coexistence campaigns are kept — beside the series, named apart from it (ADR 0134). The
 * mirror's `bench` workflow runs it when dispatched with `mode: profile`.
 */
// pnpm may forward a literal `--` (`pnpm run profile -- --rounds 1`); to parseArgs it is a separator that
// demotes every flag after it to a positional, and the run would silently take the defaults. Strip it.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.splice(0, 1);
const { values } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    rounds: { type: "string" },
    measure: { type: "string" },
    rps: { type: "string" },
    seed: { type: "string" },
    /** The commit this tree was copied from, for a run outside the repository the code is written in. */
    "source-commit": { type: "string" },
    /** Where the JSON goes, so the mirror can keep a run beside the campaigns. */
    out: { type: "string", default: "profile-report.json" },
  },
});

const num = (v: string | undefined, fallback: number): number => (v === undefined ? fallback : Number(v));
// Declared before the run below: the markdown it feeds is printed from the top level, before the module body
// reaches a declaration lower down (a `const` arrow is not hoisted for the read).
const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
// One pair is a reading; more is the same reading spent more than once. The load is the campaign's, the profile
// is of a round.
const measureSec = num(values.measure, 20);
const rps = num(values.rps, 200);
const seed = num(values.seed, 1);
const rounds = num(values.rounds, 1);

const sourceCommit = values["source-commit"];
if (sourceCommit !== undefined && !/^[0-9a-f]{7,40}$/.test(sourceCommit)) {
  console.error(`[bench] --source-commit must be a commit sha, got ${JSON.stringify(sourceCommit)}`);
  process.exit(2);
}

const dirs = {
  baseline: await mkdtemp(join(tmpdir(), "downtrace-profile-baseline-")),
  agent: await mkdtemp(join(tmpdir(), "downtrace-profile-agent-")),
};
try {
  const report = await runBench({
    rounds,
    warmupCleanSec: 3,
    warmupMaxSec: 30,
    measureSec,
    rps,
    seed,
    sourceCommit,
    // Both halves profiled: the reading is the difference between them, and a profiled side against an
    // unprofiled one is not a difference, it is two measurements that cannot be subtracted.
    baselineNodeArgs: cpuProfArgs(dirs.baseline),
    agentNodeArgs: cpuProfArgs(dirs.agent),
    log: (line) => console.error(`[bench] ${line}`),
  });
  const reading = await readProfile(report, dirs);
  console.log(profileMarkdown(reading));
  const outDir = dirname(values.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(values.out, `${JSON.stringify(reading, null, 2)}\n`);
  // The raw profiles are kept beside the report, one file per profiled round: the next doubt about a row of
  // the summary is answered by reading them, not by measuring again.
  const base = basename(values.out).replace(/\.json$/, "");
  for (const side of ["baseline", "agent"] as const) {
    const files = (await readdir(dirs[side])).filter((f) => f.endsWith(".cpuprofile")).sort();
    for (let k = 0; k < files.length; k++) {
      const name = files.length === 1 ? `${base}.${side}.cpuprofile` : `${base}.${side}-${k + 1}.cpuprofile`;
      await copyFile(join(dirs[side], files[k] ?? ""), join(outDir, name));
    }
  }
  console.error(`[bench] report written to ${values.out}`);
} finally {
  await rm(dirs.baseline, { recursive: true, force: true });
  await rm(dirs.agent, { recursive: true, force: true });
}

/** The flags that turn a round into a profile, in its own directory: one process, one file, named by the process. */
function cpuProfArgs(dir: string): string[] {
  return ["--cpu-prof", "--cpu-prof-dir", dir];
}

export interface ProfileSide {
  ok: true;
  /** How many rounds this half profiled: how many processes' profiles the reading sums. */
  files: number;
  windowMs: number;
  idleMs: number;
  totalMs: number;
  samples: number;
  groups: ProfileGroupTotal[];
  top: ProfileFunction[];
}

export type ProfileSideReading = ProfileSide | { ok: false; reason: string };

export interface ProfileHooks {
  /** The agent's own estimate of its hooks, in ms of CPU per request (ADR 0080). */
  hookMsPerRequest?: number | undefined;
  /** What the estimate puts inside the hooks, in points of one core at this run's rate. */
  insideHooksPp?: number | undefined;
  /** The pair's measured CPU, agent minus baseline, in points of one core. */
  deltaCpuPp?: number | undefined;
  /** The measured cost the estimate does not account for: it runs outside the hooks. */
  outsideHooksPp?: number | undefined;
  reason?: string | undefined;
}

export interface ProfileReading {
  kind: "profile";
  generatedAt: string;
  subject?: BenchReport["subject"] | undefined;
  host?: BenchReport["host"] | undefined;
  node: string;
  platform: string;
  config: { rounds: number; measureSec: number; rps: number; seed: number };
  baseline: ProfileSideReading;
  agent: ProfileSideReading;
  /** The hook estimate beside the measured pair, in the same unit: where the inside/outside line comes from. */
  hooks: ProfileHooks;
  /** Why no round was measured, when the run is that. */
  reason?: string | undefined;
}

async function readProfile(report: BenchReport, dirs: { baseline: string; agent: string }): Promise<ProfileReading> {
  const reading: ProfileReading = {
    kind: "profile",
    generatedAt: report.generatedAt,
    subject: report.subject,
    host: report.host,
    node: report.node,
    platform: report.platform,
    config: {
      rounds: report.config.rounds,
      measureSec: report.config.measureSec,
      rps: report.config.rps,
      seed: report.config.seed,
    },
    baseline: { ok: false, reason: "no round was measured" },
    agent: { ok: false, reason: "no round was measured" },
    hooks: {},
  };
  if (report.metrics.length === 0) {
    reading.reason = report.reason;
    return reading;
  }
  reading.baseline = await sideOf("baseline", dirs.baseline);
  reading.agent = await sideOf("agent", dirs.agent);
  reading.hooks = hooksOf(report);
  return reading;
}

async function sideOf(variant: "baseline" | "agent", dir: string): Promise<ProfileSideReading> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".cpuprofile")).sort();
  } catch {
    return { ok: false, reason: "the profile's directory is gone: nothing to read" };
  }
  if (files.length === 0) {
    // The profile is written on the process's exit; a round the harness had to kill did not get to write it.
    return {
      ok: false,
      reason: `the ${variant} process(es) did not write a profile: they were killed before their exit could write one`,
    };
  }
  // Every round of the half is a fresh process under the same load, so the half's reading is its rounds
  // summed; one file per round, in the order the rounds ran.
  const texts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
  const read = readCpuProfiles(texts);
  if (!read.ok) return { ok: false, reason: read.reason };
  return { ok: true, ...read.summary };
}

/** The inside/outside line, over the measured pairs: the estimate in the batch, the CPU in the sampler. */
function hooksOf(report: BenchReport): ProfileHooks {
  const baseline = report.rounds.filter((r) => r.variant === "baseline");
  const agent = report.rounds.filter((r) => r.variant === "agent");
  const pairs = Math.min(baseline.length, agent.length);
  if (pairs === 0) return { reason: "no measured pair: the estimate has nothing to stand beside" };
  // Paired round by round, like every comparison this package makes: the pairs saw the same machine, and the
  // difference is averaged over the pairs rather than read from one of them.
  let deltaSum = 0;
  for (let i = 0; i < pairs; i++) {
    deltaSum += (agent[i]?.usage.cpuPct ?? 0) - (baseline[i]?.usage.cpuPct ?? 0);
  }
  const delta = round(deltaSum / pairs, 3);
  const estimates = agent.map((r) => r.sink?.hookMsPerRequest).filter((v): v is number => v !== undefined);
  if (estimates.length === 0) {
    return {
      deltaCpuPp: delta,
      reason:
        "the agent's rounds did not report their own hook estimate, so only the measured side of the line is said",
    };
  }
  const hookMs = round(estimates.reduce((x, y) => x + y, 0) / estimates.length, 4);
  // A point of one core is 10 ms of CPU per second; at `rps` requests a second, ms of CPU per request is
  // points of a core times ten over the rate — the same arithmetic the campaign's report reads (gh-570).
  const inside = round((hookMs * report.config.rps) / 1000, 3);
  return {
    hookMsPerRequest: hookMs,
    insideHooksPp: inside,
    deltaCpuPp: delta,
    outsideHooksPp: round(delta - inside, 3),
  };
}

/** The markdown the campaign prints: the line, the groups, and the functions of the side that carries the agent. */
export function profileMarkdown(r: ProfileReading): string {
  const lines = [
    `### What runs outside the hooks, read by function · ${r.config.rounds} round(s) · ${r.config.rps} rps · ${r.config.measureSec}s measured`,
    "",
    "Both halves of the pair ran under the benchmark's load with `--cpu-prof`; the tables are the round's CPU",
    "by function, and the difference between them is what the agent adds to it. **This is a reading, not a",
    "verdict** of the budget: a profile of a pair says what that pair ran, and the budget is what the `bench",
    "campaign measures, the agent against no agent, over rounds.",
    "",
  ];
  if (r.reason !== undefined) {
    lines.push(`**${r.reason}**`, "");
    return lines.join("\n");
  }
  lines.push(hooksLine(r), "");
  if (r.baseline.ok && r.agent.ok && r.baseline.files === r.agent.files) {
    const baseline = r.baseline;
    const agent = r.agent;
    lines.push(
      "| Source of the CPU | Baseline (ms) | Agent (ms) | Δ (ms) |",
      "|---|---:|---:|---:|",
      ...baseline.groups.map((g, i) => {
        const other = agent.groups[i];
        // The difference runs agent minus baseline, the way the line above runs it: what the agent adds.
        const d = other !== undefined ? round(other.selfMs - g.selfMs, 1) : Number.NaN;
        return `| ${g.group} | ${g.selfMs} | ${other?.selfMs ?? "—"} | ${signed(d)} |`;
      }),
      "",
    );
  } else if (r.baseline.ok && r.agent.ok) {
    // The halves profiled different numbers of rounds: their windows are not the same length, and a
    // difference of two different windows is not a comparison.
    lines.push(
      `The halves profiled different numbers of rounds (${r.baseline.files} against ${r.agent.files}), so their windows are not the ` +
        "same length and the table does not subtract them.",
      "",
    );
  } else {
    lines.push(sideLine("baseline", r.baseline), sideLine("agent", r.agent), "");
  }
  const side = r.agent.ok ? r.agent : r.baseline.ok ? r.baseline : undefined;
  if (side) {
    const whose = side === r.agent ? "the agent's" : "the baseline's (the agent's side was not written)";
    lines.push(
      `#### The top functions of ${whose} side, by self time`,
      "",
      `The profile covers ${side.windowMs} ms of the process's life — warm-up and measured window, not only the ` +
        `${r.config.measureSec}s measured — of which the thread was idle for ${side.idleMs} ms. The idle is ` +
        `wall time, not CPU, and it is left out of the tables: the samples account for ${side.totalMs} ms of ` +
        `CPU in ${side.samples} samples.`,
      "",
      "| Function | Source | Self (ms) | % |",
      "|---|---|---:|---:|",
      ...side.top.map((f) => `| ${f.function} | ${f.group} | ${f.selfMs} | ${round(f.share * 100, 1)} |`),
      "",
    );
  }
  lines.push(
    "The raw profiles are kept beside this report, one file per profiled round: a doubt about a row is read out",
    "of them, not measured again.",
    "",
  );
  return lines.join("\n");
}

function sideLine(variant: string, side: ProfileSideReading): string {
  return side.ok
    ? `The ${variant} side: ${side.totalMs} ms of CPU in ${side.samples} samples.`
    : `The ${variant} side was not read: ${side.reason}.`;
}

function hooksLine(r: ProfileReading): string {
  const h = r.hooks;
  if (h.hookMsPerRequest === undefined || h.deltaCpuPp === undefined) {
    return (
      `The pair's measured CPU is ${signed(h.deltaCpuPp ?? Number.NaN)} pp of one core.` +
      (h.reason !== undefined ? ` ${h.reason}.` : "")
    );
  }
  const share =
    h.deltaCpuPp > 0 && h.outsideHooksPp !== undefined
      ? Math.round(((h.insideHooksPp ?? 0) / h.deltaCpuPp) * 100)
      : undefined;
  return (
    `The agent's own estimate of its hooks: ~${h.hookMsPerRequest} ms of CPU per request (sampled, ADR 0080), which is ` +
    `${h.insideHooksPp} pp of one core at ${r.config.rps} rps, against ${signed(h.deltaCpuPp)} pp measured over the pairs` +
    (share !== undefined && h.outsideHooksPp !== undefined
      ? ` — about ${share} % of the measured cost inside the hooks; ${signed(h.outsideHooksPp)} pp runs outside them.`
      : ".") +
    " It is a reading, said as one: the line the series reads is the campaign's." +
    (h.reason !== undefined ? ` ${h.reason}.` : "")
  );
}
