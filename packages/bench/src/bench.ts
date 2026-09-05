import { fileURLToPath } from "node:url";
import { type AppHandle, startReferenceApp } from "./app-process.ts";
import { runLoad } from "./load.ts";
import { ProcessSampler } from "./process-sampler.ts";
import type { BenchConfig, BenchReport, RoundResult, Variant } from "./report.ts";
import { Sink } from "./sink.ts";
import {
  type Aborted,
  applyRoundErrors,
  combineWithAbort,
  describeStatuses,
  evaluate,
  type MetricVerdict,
  type RoundMetrics,
  type Verdict,
  warmupVerdict,
} from "./verdict.ts";
import { runWarmup, type WarmupResult } from "./warmup.ts";

export const DEFAULT_AGENT_PATH = fileURLToPath(new URL("../../agent/src/register.ts", import.meta.url));

export interface BenchOptions {
  rounds?: number | undefined;
  /** Consecutive clean seconds of warmup required before measuring (default 3). */
  warmupCleanSec?: number | undefined;
  /** Give up on a round whose app is not clean after this many seconds of warmup (default 30). */
  warmupMaxSec?: number | undefined;
  measureSec?: number | undefined;
  rps?: number | undefined;
  seed?: number | undefined;
  agentPath?: string | undefined;
  /** Extra environment for both variants (e.g. STARTUP_FAILURE_MS in tests). */
  appEnv?: Record<string, string> | undefined;
  /** Extra environment for the agent variant only (e.g. DOWNTRACE_INTERVAL_MS in tests). */
  agentEnv?: Record<string, string> | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * Runs the reference app without and with the agent in alternating rounds
 * (B, A, B, A, …), each in a fresh process, under identical seeded load, and
 * compares the pooled latency and per-round resources against the budget.
 * Each round is measured only once the app has strung enough clean seconds of
 * warmup together; a round that never gets clean ends the benchmark with a
 * verdict that says so.
 */
export async function runBench(opts: BenchOptions = {}): Promise<BenchReport> {
  const config: BenchConfig = {
    rounds: opts.rounds ?? 3,
    warmupCleanSec: opts.warmupCleanSec ?? 3,
    warmupMaxSec: opts.warmupMaxSec ?? 30,
    measureSec: opts.measureSec ?? 20,
    rps: opts.rps ?? 200,
    seed: opts.seed ?? 42,
    agentPath: opts.agentPath ?? DEFAULT_AGENT_PATH,
  };
  const log = opts.log ?? (() => {});
  const rounds: RoundResult[] = [];
  let aborted: Aborted | undefined;

  outer: for (let round = 1; round <= config.rounds; round++) {
    for (const variant of ["baseline", "agent"] as Variant[]) {
      log(`round ${round}/${config.rounds} · ${variant}: starting app`);
      const sink = variant === "agent" ? new Sink() : undefined;
      let app: AppHandle;
      try {
        const sinkUrl = sink ? await sink.listen() : undefined;
        app = await startReferenceApp({
          importPath: variant === "agent" ? config.agentPath : undefined,
          env: {
            APP_VERSION: `bench-${variant}`,
            ...opts.appEnv,
            ...(sinkUrl ? { DOWNTRACE_TOKEN: "bench", DOWNTRACE_URL: sinkUrl, ...opts.agentEnv } : {}),
          },
        });
      } catch (err) {
        await sink?.close(); // the app never started: nothing else will close the sink's server
        throw err;
      }
      try {
        const warmup = await warm(app, config);
        if (!warmup.clean) {
          const w = warmupVerdict({
            variant,
            round,
            seconds: warmup.seconds,
            lastErrors: warmup.lastErrors,
            lastErrorStatuses: warmup.lastErrorStatuses,
            firstErrors: app.firstErrors(),
          });
          log(`round ${round}/${config.rounds} · ${variant}: ${w.reason}`);
          aborted = w;
          break outer;
        }
        // The measured round reports its own errors: a cold start during warmup must not fill the cap.
        app.resetErrors();
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
        const firstErrors = load.errors > 0 && app.firstErrors().length > 0 ? [...app.firstErrors()] : undefined;
        rounds.push({ round, variant, warmup, load, usage, sink: sinkStats, firstErrors });
        const errs = load.errors ? ` · errors ${load.errors} (${describeStatuses(load.errorStatuses)})` : " · errors 0";
        const appSaid = firstErrors ? ` · app: ${firstErrors.join(" | ")}` : "";
        log(
          `round ${round}/${config.rounds} · ${variant}: warmup ${warmup.seconds} s · p99 ${load.overall.p99} ms · cpu ${usage.cpuPct.toFixed(1)} % · rss ${usage.rssMaxMb.toFixed(1)} MiB${errs}${sinkStats ? ` · batches ${sinkStats.batches}` : ""}${appSaid}`,
        );
      } finally {
        await app.stop();
        await sink?.close();
      }
    }
  }

  const { metrics, verdict } = evaluateRounds(rounds, config.seed);
  const measured = applyRoundErrors(
    verdict,
    rounds.map((r) => ({
      variant: r.variant,
      round: r.round,
      errors: r.load.errors,
      errorStatuses: r.load.errorStatuses,
      firstErrors: r.firstErrors,
    })),
  );
  const checked = combineWithAbort(measured, aborted);
  return {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    config,
    rounds,
    metrics,
    verdict: checked.verdict,
    reason: checked.reason,
  };
}

/** One second of the seeded load at a time; each second uses a different slice of the plan so every endpoint gets warm. */
function warm(app: AppHandle, config: BenchConfig): Promise<WarmupResult> {
  return runWarmup({ cleanSec: config.warmupCleanSec, maxSec: config.warmupMaxSec }, async (second) => {
    const slice = await runLoad({
      baseUrl: app.baseUrl,
      rps: config.rps,
      durationSec: 1,
      seed: config.seed + second,
      // A slice waits for its own requests, so the default 10 s timeout would stretch every second of a stalled
      // warmup to eleven and make `warmupMaxSec` a lie. A request that takes 5 s is not a warm application anyway.
      requestTimeoutMs: 5_000,
    });
    return { errors: slice.errors, errorStatuses: slice.errorStatuses };
  });
}

/** Metrics over the rounds that were measured; empty when a variant has none (the verdict then comes from the abort). */
function evaluateRounds(rounds: readonly RoundResult[], seed: number): { metrics: MetricVerdict[]; verdict: Verdict } {
  const of = (variant: Variant) => rounds.filter((r) => r.variant === variant);
  if (of("baseline").length === 0 || of("agent").length === 0) return { metrics: [], verdict: "inconclusive" };
  const toMetrics = (variant: Variant): RoundMetrics[] =>
    of(variant).map((r) => ({ p99Ms: r.load.overall.p99, cpuPct: r.usage.cpuPct, rssMb: r.usage.rssMaxMb }));
  const pools = (variant: Variant) => of(variant).map((r) => r.load.samples);
  return evaluate(toMetrics("baseline"), toMetrics("agent"), undefined, {
    baseline: pools("baseline"),
    agent: pools("agent"),
    seed,
  });
}
