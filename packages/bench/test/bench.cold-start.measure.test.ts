import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";
import { requireInCI } from "./helpers.ts";

const DATABASE_URL = process.env.DATABASE_URL;
requireInCI("DATABASE_URL", DATABASE_URL);

const log = (line: string): void => console.info(`[bench] ${line}`);

/**
 * The half of the warmup gate that **measures**: waiting out a 4 s cold start has to produce a round of
 * between six and ten seconds with no errors in it, and how long a warmup takes is a fact about the
 * machine as much as about the code.
 *
 * Out of CI for the reason the ADR 0032 gave for the benchmark itself: measured on a machine running
 * seven other jobs, the number says more about the neighbours than about this. Run by `make bench-measure`
 * (gh-412).
 */
describe.skipIf(!DATABASE_URL)("bench warmup gate (measure)", () => {
  it("waits out a 4 s cold start and measures a clean round", { timeout: 120_000 }, async () => {
    const report = await runBench({
      log,
      rounds: 1,
      warmupCleanSec: 3,
      warmupMaxSec: 30,
      measureSec: 2,
      rps: 100,
      seed: 1,
      agentPath: DEFAULT_AGENT_PATH,
      appEnv: { STARTUP_FAILURE_MS: "4000" },
    });
    expect(report.rounds).toHaveLength(2);
    for (const r of report.rounds) {
      expect(r.warmup.clean, `${r.variant} warmup`).toBe(true);
      // 4 failing seconds, then 3 clean ones; slices are not perfectly aligned to the wall clock.
      expect(r.warmup.seconds, `${r.variant} warmup seconds`).toBeGreaterThanOrEqual(6);
      expect(r.warmup.seconds, `${r.variant} warmup seconds`).toBeLessThanOrEqual(10);
      expect(r.load.errors, `${r.variant} errors while measuring`).toBe(0);
      expect(r.firstErrors).toBeUndefined();
    }
    // No assertion on the overhead verdict: one round of 2 s is 200 samples per variant, where the p99 rests on two
    // of them and cannot resolve a 1 ms budget. What this test covers is the gate, so the assertion is that the
    // bench measured both rounds instead of aborting on warmup.
    //
    // That used to be spelled `reason === undefined`, which worked only while nothing else could set one. Since
    // gh-200 a pair whose two halves saw different neighbours is reported as not comparable, and on a CI machine
    // with other jobs on it that is the normal answer — and a true one. What must not appear is the abort.
    expect(report.reason ?? "").not.toContain("could not warm up");
  });
});
