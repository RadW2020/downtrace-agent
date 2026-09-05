import { fileURLToPath } from "node:url";
import { createReferenceApp, type ReferenceApp } from "@downtrace/reference-app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";
import { runLoad } from "../src/load.ts";
import { must } from "./helpers.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn("[bench] DATABASE_URL not set: skipping integration tests");

const SLOW_AGENT = fileURLToPath(new URL("../fixtures/slow-agent.ts", import.meta.url));

const log = (line: string): void => console.info(`[bench] ${line}`);

describe.skipIf(!DATABASE_URL)("bench (integration)", () => {
  it("bench with a tail-stalling agent (every 50th request +200 ms): fails on p99 and names it", {
    timeout: 240_000,
  }, async () => {
    const report = await runBench({
      log,
      rounds: 2,
      warmupSec: 1,
      measureSec: 3,
      rps: 100,
      seed: 1,
      agentPath: SLOW_AGENT,
    });
    const p99 = must(
      report.metrics.find((m) => m.metric === "p99Ms"),
      "p99Ms metric",
    );
    const rounds = report.rounds
      .map(
        (r) =>
          `${r.variant}#${r.round} p50=${r.load.overall.p50} p99=${r.load.overall.p99} max=${r.load.overall.max} n=${r.load.completed} err=${r.load.errors}`,
      )
      .join(" | ");
    console.info(
      `[bench] stalling agent: p99 Δ${p99.delta} ms, noise ${p99.noise} ms → ${report.verdict} :: ${rounds}`,
    );
    // A slowed-down app must still answer correctly; fast failures would look like low latency.
    expect(
      report.rounds.every((r) => r.load.errors === 0),
      rounds,
    ).toBe(true);
    // 2 % of requests stalled by 200 ms moves the p99 by ~180 ms: far above any machine noise seen so far (≤ 75 ms).
    expect(p99.delta, rounds).toBeGreaterThanOrEqual(100);
    expect(p99.status).toBe("fail");
    expect(report.verdict).toBe("fail");
  });
});
