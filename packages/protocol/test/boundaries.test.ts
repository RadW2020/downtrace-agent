import { describe, expect, it } from "vitest";
import { AGGREGATES_SCHEMA_V0, LATENCY_BOUNDARIES_V0, LATENCY_BUCKETS_V0, latencyBucket } from "../src/index.ts";

describe("latency buckets v0", () => {
  it("come from the schema, are ascending and match the counts length", () => {
    const fromSchema = (AGGREGATES_SCHEMA_V0.$defs.LatencyHistogram as Record<string, unknown>)[
      "x-latency-boundaries-ms"
    ];
    expect(LATENCY_BOUNDARIES_V0).toEqual(fromSchema);
    expect(LATENCY_BUCKETS_V0).toBe(LATENCY_BOUNDARIES_V0.length + 1);
    expect(AGGREGATES_SCHEMA_V0.$defs.LatencyHistogram.properties.counts.minItems).toBe(LATENCY_BUCKETS_V0);
    for (let i = 1; i < LATENCY_BOUNDARIES_V0.length; i++) {
      expect(LATENCY_BOUNDARIES_V0[i]).toBeGreaterThan(LATENCY_BOUNDARIES_V0[i - 1] ?? Number.NaN);
    }
  });

  it("assigns latencies to the first bucket whose bound is >= the value", () => {
    expect(latencyBucket(0)).toBe(0);
    expect(latencyBucket(0.5)).toBe(0);
    expect(latencyBucket(0.51)).toBe(1);
    expect(latencyBucket(1)).toBe(1);
    expect(latencyBucket(350)).toBe(19); // (300, 400]
    expect(latencyBucket(60000)).toBe(33);
    expect(latencyBucket(60001)).toBe(34);
    expect(latencyBucket(Number.POSITIVE_INFINITY)).toBe(LATENCY_BUCKETS_V0 - 1);
  });
});
