import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";
import { must, requireInCI } from "./helpers.ts";

const DATABASE_URL = process.env.DATABASE_URL;
requireInCI("DATABASE_URL", DATABASE_URL);

const log = (line: string): void => console.info(`[bench] ${line}`);

/**
 * The reference app can fake a cold database: STARTUP_FAILURE_MS of 503s after its first request. These
 * tests drive the warmup gate with real processes, and every assertion here is about **what the bench
 * decides**, never about how long anything took: an app that never gets clean is not a measurement, it is
 * a refusal, and a refusal reads the same on a quiet machine and on a busy one (gh-412).
 *
 * The case that does measure —waiting out a cold start and producing a clean round of a known length—
 * lives in `bench.cold-start.measure.test.ts`.
 */
describe.skipIf(!DATABASE_URL)("bench warmup gate (integration)", () => {
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
    // Lines are now distinct by status and error name, so which path lost the race is not deterministic.
    expect(reason).toMatch(/app: 503 [A-Z]+ \/\S* ColdStartError: database not ready yet/);
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
