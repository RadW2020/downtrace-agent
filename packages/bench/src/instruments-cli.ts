import { parseArgs } from "node:util";
import { runBench } from "./bench.ts";
import { round } from "./stats.ts";

/**
 * Measures what each observer costs on its own, instead of only what they cost together.
 *
 * The agent's budget is a single number for the whole agent, so when it starts to run out the only useful
 * question is which observer to pay for and which to drop. That cannot be answered from one total.
 *
 * Each step compares two agent configurations **head to head**: the same agent with one more observer against the
 * same agent without it. Measuring each against a no-agent baseline and subtracting would difference two
 * independent measurements and double the uncertainty, which on an ordinary machine is enough to hide every
 * observer's cost. The first row is the only one measured against no agent at all.
 *
 * It is not part of CI: it is one full benchmark per step, and it is a tool for a decision, not a gate.
 */
const { values } = parseArgs({
  allowPositionals: true,
  options: {
    rounds: { type: "string" },
    measure: { type: "string" },
    rps: { type: "string" },
    seed: { type: "string" },
  },
});

const num = (v: string | undefined, fallback: number): number => (v === undefined ? fallback : Number(v));
const rounds = num(values.rounds, 5);
const measureSec = num(values.measure, 12);
const rps = num(values.rps, 200);
const seed = num(values.seed, 1);

/** Each step adds one observer to the one before it, so the difference is that observer's own cost. */
const steps = [
  { name: "the agent itself", from: undefined, to: "none" },
  { name: "runtime health", from: "none", to: "runtime" },
  { name: "postgres", from: "runtime", to: "runtime,pg" },
  { name: "outgoing HTTP", from: "runtime,pg", to: "runtime,pg,http" },
  { name: "redis", from: "runtime,pg,http", to: "runtime,pg,http,redis" },
];

interface Step {
  name: string;
  cpu: number;
  cpuNoise: number;
  p99: number;
  resolved: boolean;
}

const results: Step[] = [];
for (const step of steps) {
  const report = await runBench({
    rounds,
    warmupCleanSec: 3,
    warmupMaxSec: 30,
    measureSec,
    rps,
    seed,
    // `from: undefined` means a baseline with no agent: the cost of the agent before any observer is added.
    ...(step.from === undefined ? {} : { baselineEnv: { DOWNTRACE_INSTRUMENT: step.from } }),
    agentEnv: { DOWNTRACE_INSTRUMENT: step.to },
    log: (line) => console.error(`[bench] ${step.name}: ${line}`),
  });
  const cpu = report.metrics.find((m) => m.metric === "cpuPct");
  const p99 = report.metrics.find((m) => m.metric === "p99Ms");
  const delta = cpu?.delta ?? Number.NaN;
  const noise = cpu?.noise ?? Number.NaN;
  results.push({
    name: step.name,
    cpu: delta,
    cpuNoise: noise,
    p99: p99?.delta ?? Number.NaN,
    resolved: Math.abs(delta) > noise,
  });
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

const lines = [
  `### What each observer costs · ${rounds} rounds/side · ${rps} rps · ${measureSec}s measured`,
  "",
  "Each row is one head-to-head comparison: the agent with that observer against the same agent without it. The",
  "first row is the agent with nothing switched on, against no agent at all.",
  "",
  "`resolved?` says whether the cost came out larger than the machine's own noise. Where it says no, this machine",
  "could not measure that observer and the number should not be read as one.",
  "",
  "| Cost of | ΔCPU (pp) | noise | resolved? | Δp99 (ms) |",
  "|---|---:|---:|:-:|---:|",
  ...results.map(
    (r) =>
      `| ${r.name} | ${signed(round(r.cpu, 3))} | ${round(r.cpuNoise, 3)} | ${r.resolved ? "yes" : "no"} | ${signed(round(r.p99, 3))} |`,
  ),
  "",
];

const unresolved = results.filter((r) => !r.resolved).length;
if (unresolved > 0) {
  lines.push(
    `${unresolved} of ${results.length} could not be resolved here. More rounds or a quieter machine is the answer;`,
    "reading the numbers anyway is not.",
    "",
  );
}

console.log(lines.join("\n"));
