import { createReferenceApp, type ReferenceApp } from "@downtrace/reference-app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLoad } from "../src/load.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn("[bench] DATABASE_URL not set: skipping integration tests");

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
});
