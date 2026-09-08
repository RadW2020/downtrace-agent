import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn("[bench] DATABASE_URL not set: skipping integration tests");

const log = (line: string): void => console.info(`[bench] ${line}`);

describe.skipIf(!DATABASE_URL)("bench (integration)", () => {
  // The real agent, fully active, pointed at somewhere nothing is listening: it observes, aggregates and tries to
  // ship, and none of it arrives. That is not a measurement of the agent shipping, so it must not turn into a
  // verdict about the budget — which is what happened before gh-134, with "Agent shipped 0 batch(es)" as the only
  // hint, buried in the prose of a report that still said pass.
  it("an agent that cannot deliver fails the run instead of producing a budget verdict", {
    timeout: 180_000,
  }, async () => {
    const report = await runBench({
      log,
      rounds: 2,
      warmupCleanSec: 1,
      measureSec: 2,
      rps: 50,
      seed: 1,
      agentPath: DEFAULT_AGENT_PATH,
      // Nothing listens on port 1, so every send fails outside the request path.
      agentEnv: { DOWNTRACE_URL: "http://127.0.0.1:1", DOWNTRACE_INTERVAL_MS: "500" },
    });

    expect(report.rounds.filter((r) => r.variant === "agent").every((r) => (r.sink?.batches ?? 0) === 0)).toBe(true);
    expect(report.verdict).toBe("fail");
    expect(report.reason).toContain("no batches");
    expect(report.reason).toContain("agent#1");
    // The requests themselves were fine: the agent must not break the application while failing to ship.
    expect(report.rounds.every((r) => r.load.errors === 0)).toBe(true);
  });
});
