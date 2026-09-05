import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn("[bench] DATABASE_URL not set: skipping integration tests");

const log = (line: string): void => console.info(`[bench] ${line}`);

describe.skipIf(!DATABASE_URL)("bench (integration)", () => {
  // 6 s × 100 rps × 3 rounds = 1800 pooled samples per variant. With 3 s rounds the p99 rested on the 3 worst of
  // 300 samples and a laptop hiccup during agent rounds produced a false `fail` (Δ +6.7 ms, not reproducible).
  // If this fails again, rerun `make bench` before suspecting the agent: a real regression shows up in every round.
  it("bench with the real agent shipping to a sink: 3 rounds/variant, never fails", { timeout: 240_000 }, async () => {
    const report = await runBench({
      log,
      rounds: 3,
      warmupSec: 1,
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
    expect(report.verdict).not.toBe("fail");
  });
});
