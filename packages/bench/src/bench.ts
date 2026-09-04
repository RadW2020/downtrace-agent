import { fileURLToPath } from "node:url";
import { startReferenceApp } from "./app-process.ts";
import { runLoad } from "./load.ts";
import { ProcessSampler } from "./process-sampler.ts";
import type { BenchConfig, BenchReport, RoundResult, Variant } from "./report.ts";
import { Sink } from "./sink.ts";
import { evaluate, type RoundMetrics } from "./verdict.ts";

export const DEFAULT_AGENT_PATH = fileURLToPath(new URL("../../agent/src/register.ts", import.meta.url));

export interface BenchOptions {
  rounds?: number | undefined;
  warmupSec?: number | undefined;
  measureSec?: number | undefined;
  rps?: number | undefined;
  seed?: number | undefined;
  agentPath?: string | undefined;
  /** Extra environment for the agent variant (e.g. DOWNTRACE_INTERVAL_MS in tests). */
  agentEnv?: Record<string, string> | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * Runs the reference app without and with the agent in alternating rounds
 * (B, A, B, A, …), each in a fresh process, under identical seeded load, and
 * compares medians against the budget.
 */
export async function runBench(opts: BenchOptions = {}): Promise<BenchReport> {
  const config: BenchConfig = {
    rounds: opts.rounds ?? 3,
    warmupSec: opts.warmupSec ?? 5,
    measureSec: opts.measureSec ?? 20,
    rps: opts.rps ?? 200,
    seed: opts.seed ?? 42,
    agentPath: opts.agentPath ?? DEFAULT_AGENT_PATH,
  };
  const log = opts.log ?? (() => {});
  const rounds: RoundResult[] = [];

  for (let round = 1; round <= config.rounds; round++) {
    for (const variant of ["baseline", "agent"] as Variant[]) {
      log(`round ${round}/${config.rounds} · ${variant}: starting app`);
      const sink = variant === "agent" ? new Sink() : undefined;
      const sinkUrl = sink ? await sink.listen() : undefined;
      const app = await startReferenceApp({
        importPath: variant === "agent" ? config.agentPath : undefined,
        env: {
          APP_VERSION: `bench-${variant}`,
          ...(sinkUrl ? { DOWNTRACE_TOKEN: "bench", DOWNTRACE_URL: sinkUrl, ...opts.agentEnv } : {}),
        },
      });
      try {
        await runLoad({ baseUrl: app.baseUrl, rps: config.rps, durationSec: config.warmupSec, seed: config.seed });
        const sampler = new ProcessSampler(app.baseUrl);
        await sampler.start();
        const load = await runLoad({
          baseUrl: app.baseUrl,
          rps: config.rps,
          durationSec: config.measureSec,
          seed: config.seed,
        });
        const usage = await sampler.stop();
        await app.stop(); // SIGTERM: the agent flushes its last interval before the sink closes
        const sinkStats = sink ? { ...sink.stats } : undefined;
        rounds.push({ round, variant, load, usage, sink: sinkStats });
        log(
          `round ${round}/${config.rounds} · ${variant}: p99 ${load.overall.p99} ms · cpu ${usage.cpuPct.toFixed(1)} % · rss ${usage.rssMaxMb.toFixed(1)} MiB · errors ${load.errors}${sinkStats ? ` · batches ${sinkStats.batches}` : ""}`,
        );
      } finally {
        await app.stop();
        await sink?.close();
      }
    }
  }

  const toMetrics = (variant: Variant): RoundMetrics[] =>
    rounds
      .filter((r) => r.variant === variant)
      .map((r) => ({ p99Ms: r.load.overall.p99, cpuPct: r.usage.cpuPct, rssMb: r.usage.rssMaxMb }));
  const { metrics, verdict } = evaluate(toMetrics("baseline"), toMetrics("agent"));

  return {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    config,
    rounds,
    metrics,
    verdict,
  };
}
