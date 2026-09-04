import { parseArgs } from "node:util";
import { runLoad } from "./load.ts";

const { values } = parseArgs({
  allowPositionals: true, // pnpm may forward a literal `--`
  options: {
    url: { type: "string", default: "http://127.0.0.1:4000" },
    rps: { type: "string", default: "200" },
    duration: { type: "string", default: "10" },
    seed: { type: "string", default: "42" },
    json: { type: "boolean", default: false },
  },
});

const report = await runLoad({
  baseUrl: values.url,
  rps: Number(values.rps),
  durationSec: Number(values.duration),
  seed: Number(values.seed),
});

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `${report.completed}/${report.requested} requests · ${report.errors} errors · ${report.achievedRps} rps (target ${report.targetRps}) · ${report.elapsedMs} ms`,
  );
  console.log("");
  console.log("endpoint             count  errors     p50     p95     p99     max");
  const row = (
    name: string,
    r: { count: number; errors: number; p50: number; p95: number; p99: number; max: number },
  ) =>
    console.log(
      `${name.padEnd(20)} ${String(r.count).padStart(5)} ${String(r.errors).padStart(7)} ${r.p50.toFixed(2).padStart(7)} ${r.p95.toFixed(2).padStart(7)} ${r.p99.toFixed(2).padStart(7)} ${r.max.toFixed(2).padStart(7)}`,
    );
  for (const [name, r] of Object.entries(report.byEndpoint)) row(name, r);
  row("overall", { ...report.overall, count: report.completed, errors: report.errors });
}
process.exitCode = report.errors > 0 ? 1 : 0;
