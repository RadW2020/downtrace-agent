import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn("[bench] DATABASE_URL not set: skipping integration tests");

const log = (line: string): void => console.info(`[bench] ${line}`);

describe.skipIf(!DATABASE_URL)("bench (integration)", () => {
  // A smoke test of the harness against the real agent, not a check of the overhead budget. 6 s × 100 rps × 3
  // rounds is 1800 samples per variant, and a shared runner moves the pooled p99 by more than the whole budget:
  // on 2026-09-06 this measured Δ +11.665 ms and Δ +0.012 ms on the same commit minutes apart, while the `bench`
  // job, with 12000 samples, passed on both runs. Asserting a verdict here would be asserting something the
  // sample size cannot support, so what is checked is that the harness ran: rounds alternate, the agent shipped
  // its batches, nothing errored, and a verdict was produced. The budget is the `bench` job's business.
  it("bench with the real agent shipping to a sink: 3 rounds/variant, measured end to end", {
    timeout: 240_000,
  }, async () => {
    const report = await runBench({
      log,
      rounds: 3,
      warmupCleanSec: 1,
      measureSec: 6,
      rps: 100,
      seed: 1,
      agentPath: DEFAULT_AGENT_PATH,
      agentEnv: { DOWNTRACE_INTERVAL_MS: "1000" },
    });
    expect(report.rounds).toHaveLength(6);
    expect(report.rounds.map((r) => r.variant)).toEqual([
      "baseline",
      "agent",
      "baseline",
      "agent",
      "baseline",
      "agent",
    ]);
    expect(report.rounds.every((r) => r.load.errors === 0)).toBe(true);
    expect(report.metrics.map((m) => m.metric)).toEqual(["p99Ms", "cpuPct", "rssMb"]);
    for (const r of report.rounds.filter((x) => x.variant === "agent")) expect(r.sink?.batches ?? 0).toBeGreaterThan(0);
    expect(report.rounds.filter((x) => x.variant === "baseline").every((x) => x.sink === undefined)).toBe(true);
    console.info(
      `[bench] empty agent verdict: ${report.verdict}`,
      report.metrics.map((m) => `${m.metric} Δ${m.delta} noise ${m.noise}`).join(" · "),
    );
    // A verdict was reached from measured rounds, rather than the run being abandoned mid-way.
    expect(["pass", "fail", "inconclusive"]).toContain(report.verdict);
    expect(report.reason).toBeUndefined();
  });
});
