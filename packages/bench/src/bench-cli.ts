import { parseArgs } from "node:util";
import { runBench } from "./bench.ts";
import { appendStepSummary, toMarkdown, writeJson } from "./report.ts";

const { values } = parseArgs({
  allowPositionals: true, // pnpm may forward a literal `--`
  options: {
    rounds: { type: "string" },
    warmup: { type: "string" },
    measure: { type: "string" },
    rps: { type: "string" },
    seed: { type: "string" },
    agent: { type: "string" },
    out: { type: "string", default: "bench-report.json" },
  },
});

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

const report = await runBench({
  rounds: num(values.rounds),
  warmupSec: num(values.warmup),
  measureSec: num(values.measure),
  rps: num(values.rps),
  seed: num(values.seed),
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
  console.error(`${process.env.GITHUB_ACTIONS ? "::error::" : ""}overhead budget exceeded: ${broken.join("; ")}`);
  process.exitCode = 1;
} else if (report.verdict === "inconclusive") {
  console.error(
    `${process.env.GITHUB_ACTIONS ? "::warning::" : ""}inconclusive: machine noise exceeds the budget for ${broken.join("; ")}`,
  );
}
