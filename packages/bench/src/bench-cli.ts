import { parseArgs } from "node:util";
import { runBench } from "./bench.ts";
import { appendStepSummary, toMarkdown, writeJson } from "./report.ts";

const { values } = parseArgs({
  allowPositionals: true, // pnpm may forward a literal `--`
  options: {
    rounds: { type: "string" },
    /** Consecutive clean seconds of warmup before measuring. */
    warmup: { type: "string" },
    /** Give up on a round that is not clean after this many seconds. */
    "warmup-max": { type: "string" },
    measure: { type: "string" },
    rps: { type: "string" },
    seed: { type: "string" },
    agent: { type: "string" },
    out: { type: "string", default: "bench-report.json" },
  },
});

/** Configuration is validated once, here: a bad flag is a usage error, never a benchmark that reports "NaN s". */
function num(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[bench] --${name} must be a positive number, got ${JSON.stringify(v)}`);
    process.exit(2);
  }
  return n;
}

const report = await runBench({
  rounds: num("rounds", values.rounds),
  warmupCleanSec: num("warmup", values.warmup),
  warmupMaxSec: num("warmup-max", values["warmup-max"]),
  measureSec: num("measure", values.measure),
  rps: num("rps", values.rps),
  seed: num("seed", values.seed),
  agentPath: values.agent,
  log: (line) => console.error(`[bench] ${line}`),
});

const md = toMarkdown(report);
await writeJson(report, values.out);
console.log(md);
if (await appendStepSummary(md)) console.error(`[bench] summary appended to $GITHUB_STEP_SUMMARY`);
console.error(`[bench] report written to ${values.out}`);

const broken = report.metrics
  .filter((m) => m.status !== "ok")
  .map((m) => `${m.metric} Δ${m.delta}${m.unit} (budget ${m.budget}, noise ${m.noise})`);
if (report.verdict === "fail") {
  console.error(
    `${process.env.GITHUB_ACTIONS ? "::error::" : ""}${report.reason ?? `overhead budget exceeded: ${broken.join("; ")}`}`,
  );
  process.exitCode = 1;
} else if (report.verdict === "inconclusive") {
  console.error(
    `${process.env.GITHUB_ACTIONS ? "::warning::" : ""}inconclusive: ${report.reason ?? `machine noise exceeds the budget for ${broken.join("; ")}`}`,
  );
}
