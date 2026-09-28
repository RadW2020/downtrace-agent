import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_TRACKER_PATH, repoRoot, runBench } from "./bench.ts";
import { METRICS } from "./budget.ts";
import { coexistenceMarkdown, readCoexistence } from "./coexistence.ts";
import { COEXISTENCE } from "./instruments-steps.ts";
import { gate, roundsToResolve, smallestP } from "./significance.ts";
import { round } from "./stats.ts";

/**
 * Measures what it costs the reference app to have the agent and the tracker loaded together — the half of
 * ESC-16 that is a measurement and not a fact (gh-615).
 *
 * One head-to-head comparison: the whole agent against the whole agent with the tracker beside it. The deltas
 * it reads are the tracker's cost, reported as such — the budget of invariant 3 is the instrumentation's, and
 * a pass or a fail of it against this pair would be a verdict the measurement does not make. What the run does
 * read against the budget is the agent's own estimate of its hooks in the two configurations: sampled inside
 * `guard` (ADR 0080), it cannot contain the tracker's work, and whether it moved is a row.
 *
 * Not part of CI: it is one full benchmark, and it is a tool for reading, not a gate (ADR 0032, 0134). The
 * mirror's `bench` workflow runs it when dispatched with `mode: coexistence`.
 */
const { values } = parseArgs({
  allowPositionals: true, // pnpm may forward a literal `--`
  options: {
    rounds: { type: "string" },
    measure: { type: "string" },
    rps: { type: "string" },
    seed: { type: "string" },
    /** The commit this tree was copied from, for a run outside the repository the code is written in. */
    "source-commit": { type: "string" },
    /** Where the JSON goes, so the mirror can keep a run beside the campaigns. */
    out: { type: "string", default: "coexistence-report.json" },
  },
});

const num = (v: string | undefined, fallback: number): number => (v === undefined ? fallback : Number(v));
const measureSec = num(values.measure, 12);
const rps = num(values.rps, 200);
const seed = num(values.seed, 1);

const sourceCommit = values["source-commit"];
if (sourceCommit !== undefined && !/^[0-9a-f]{7,40}$/.test(sourceCommit)) {
  console.error(`[bench] --source-commit must be a commit sha, got ${JSON.stringify(sourceCommit)}`);
  process.exit(2);
}

// The run makes one comparison per metric plus the agent's own hook estimate; the level is shared among them
// (Bonferroni, ADR 0027), and the default is the fewest rounds at which any of them could clear it: fewer is
// a run that cannot conclude, said before the machine is spent.
const comparisons = METRICS.length + 1;
const alpha = gate(1, comparisons).alpha;
const rounds = num(values.rounds, roundsToResolve(comparisons));
if (smallestP(rounds) >= alpha) {
  const needed = roundsToResolve(comparisons);
  console.error(
    `[bench] ${rounds} rounds/side cannot resolve ${comparisons} comparisons: the smallest reachable p is ` +
      `${round(smallestP(rounds), 4)} and the gate is ${round(alpha, 4)}. Use --rounds ${needed} or more.`,
  );
  process.exit(1);
}

const report = await runBench({
  rounds,
  warmupCleanSec: 3,
  warmupMaxSec: 30,
  measureSec,
  rps,
  seed,
  sourceCommit,
  // The step says what differs; the harness owns the tracker's two faces together — the module and a per-round
  // local sink the DSN points at — so a start-up can never have the tracker without its sink or the other way.
  baselineEnv: { ...COEXISTENCE.from },
  agentEnv: { ...COEXISTENCE.to },
  agentTracker: COEXISTENCE.tracker ? DEFAULT_TRACKER_PATH : undefined,
  log: (line) => console.error(`[bench] ${line}`),
});

const reading = readCoexistence(
  report,
  {
    name: COEXISTENCE.name,
    module: relative(repoRoot(), DEFAULT_TRACKER_PATH),
    version: trackerVersion(),
  },
  comparisons,
);

console.log(coexistenceMarkdown(reading));
await writeFile(values.out, `${JSON.stringify(reading, null, 2)}\n`);
console.error(`[bench] report written to ${values.out}`);
if (reading.tracker.envelopes === 0) {
  // A tracker that shipped nothing while its side was measured did not take part in the comparison it sits in.
  console.error("[bench] the tracker shipped nothing to its local sink: the side that was measured is the agent alone");
}

/** The tracker's pinned version, as the reference app's manifest names it: a fact that lives in one place. */
function trackerVersion(): string | undefined {
  try {
    const manifestPath = fileURLToPath(new URL("../../reference-app/package.json", import.meta.url));
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const devDependencies = (manifest as { devDependencies?: Record<string, unknown> }).devDependencies;
    const version = devDependencies?.["@sentry/node"];
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}
