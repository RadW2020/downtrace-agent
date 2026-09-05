import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";
import { must } from "./helpers.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn("[bench] DATABASE_URL not set: skipping integration tests");

const log = (line: string): void => console.info(`[bench] ${line}`);

/**
 * The reference app can fake a cold database: STARTUP_FAILURE_MS of 503s after
 * its first request. These tests drive the warmup gate with real processes.
 */
describe.skipIf(!DATABASE_URL)("bench warmup gate (integration)", () => {
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
    expect(report.verdict).not.toBe("fail");
    expect(report.reason).toBeUndefined();
  });

  it("baseline that never gets clean: inconclusive, with what the app said", { timeout: 60_000 }, async () => {
    const report = await runBench({
      log,
      rounds: 1,
      warmupCleanSec: 2,
      warmupMaxSec: 4,
      measureSec: 2,
      rps: 100,
      seed: 1,
      agentPath: DEFAULT_AGENT_PATH,
      appEnv: { STARTUP_FAILURE_MS: "600000" },
    });
    expect(report.rounds).toHaveLength(0);
    expect(report.metrics).toHaveLength(0);
    expect(report.verdict).toBe("inconclusive");
    const reason = must(report.reason, "reason");
    expect(reason).toMatch(
      /^baseline round could not warm up, nothing can be measured — baseline#1: app not clean after 4 s of warmup — last second: \d+ failed \(503×\d+\)/,
    );
    expect(reason).toContain("503 GET /products ColdStartError: database not ready yet");
  });

  it("agent variant that never gets clean while the baseline did: fail", { timeout: 60_000 }, async () => {
    const report = await runBench({
      log,
      rounds: 1,
      warmupCleanSec: 2,
      warmupMaxSec: 4,
      measureSec: 2,
      rps: 100,
      seed: 1,
      agentPath: DEFAULT_AGENT_PATH,
      agentEnv: { STARTUP_FAILURE_MS: "600000" },
    });
    expect(report.rounds.map((r) => r.variant)).toEqual(["baseline"]);
    expect(report.verdict).toBe("fail");
    expect(must(report.reason, "reason")).toMatch(
      /^agent round could not warm up — agent#1: app not clean after 4 s of warmup/,
    );
  });
});
