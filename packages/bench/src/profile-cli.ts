import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./bench.ts";
import { cliArgs } from "./cli-args.ts";
import { readCpuProfiles } from "./cpu-profile.ts";
import { hooksOf, type ProfileReading, type ProfileSideReading, profileMarkdown } from "./profile-reading.ts";
import type { BenchReport } from "./report.ts";

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
const { values } = parseArgs({
  args: cliArgs(process.argv.slice(2)),
  allowPositionals: false, // whatever is left over is a usage error, never a campaign run on the defaults (gh-853)
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
