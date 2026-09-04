import { fileURLToPath } from "node:url";
import { createReferenceApp, type ReferenceApp } from "@downtrace/reference-app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PATH, runBench } from "../src/bench.ts";
import { runLoad } from "../src/load.ts";
import { must } from "./helpers.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn("[bench] DATABASE_URL not set: skipping integration tests");

const SLOW_AGENT = fileURLToPath(new URL("../fixtures/slow-agent.ts", import.meta.url));

describe.skipIf(!DATABASE_URL)("bench (integration)", () => {
  let ref: ReferenceApp;
  let base: string;

  beforeAll(async () => {
    ref = createReferenceApp({
      port: 0,
      providerPort: 0,
      databaseUrl: DATABASE_URL ?? "",
      redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    });
    base = `http://127.0.0.1:${(await ref.start()).port}`;
  });
  afterAll(() => ref.stop());

  it("load: 100 rps for 3 s → no errors, rate within ±10 %, all endpoints exercised", { timeout: 30_000 }, async () => {
    const report = await runLoad({ baseUrl: base, rps: 100, durationSec: 3, seed: 1 });
    expect(report.requested).toBe(300);
    expect(report.completed).toBe(300);
    expect(report.errors).toBe(0);
    expect(Math.abs(report.achievedRps - 100)).toBeLessThanOrEqual(10);
    expect(Object.keys(report.byEndpoint).sort()).toEqual([
      "GET /me",
      "GET /products",
      "GET /products/:id",
      "POST /checkout",
    ]);
    expect(report.overall.p50).toBeGreaterThan(0);
  });

  it("bench with the real agent shipping to a sink: 3 rounds/variant, never fails", { timeout: 240_000 }, async () => {
    const report = await runBench({
      rounds: 3,
      warmupSec: 1,
      measureSec: 3,
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

  it("bench with a 5 ms slow agent: fails on p99 and names it", { timeout: 240_000 }, async () => {
    const report = await runBench({ rounds: 2, warmupSec: 1, measureSec: 3, rps: 100, seed: 1, agentPath: SLOW_AGENT });
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
    console.info(`[bench] slow agent: p99 Δ${p99.delta} ms, noise ${p99.noise} ms → ${report.verdict} :: ${rounds}`);
    // A slowed-down app must still answer correctly; fast failures would look like low latency.
    expect(
      report.rounds.every((r) => r.load.errors === 0),
      rounds,
    ).toBe(true);
    expect(p99.delta, rounds).toBeGreaterThanOrEqual(4);
    expect(p99.status).toBe("fail");
    expect(report.verdict).toBe("fail");
  });
});
