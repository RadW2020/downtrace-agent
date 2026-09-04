import { LATENCY_BUCKETS_V0 } from "@downtrace/protocol";
import { describe, expect, it } from "vitest";
import { IntervalAggregator } from "../src/aggregator.ts";
import { OTHER_ROUTE } from "../src/routes.ts";

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe("IntervalAggregator", () => {
  it("counts requests, status classes, errors and latency per route", () => {
    let t = 1_000;
    const agg = new IntervalAggregator(500, () => t);
    agg.record("GET", "/products", 200, 3.2);
    agg.record("GET", "/products", 200, 4.8);
    agg.record("GET", "/products", 404, 1.1);
    agg.record("GET", "/products", 503, 950);
    agg.record("POST", "/checkout", 201, 350);
    t = 11_000;
    const interval = agg.rotate();
    expect(interval).not.toBeNull();
    expect(interval?.start).toBe(1_000);
    expect(interval?.durationMs).toBe(10_000);
    const products = interval?.endpoints.find((e) => e.route === "/products");
    expect(products).toMatchObject({
      method: "GET",
      count: 4,
      errors: 1,
      status: { success: 2, redirect: 0, clientError: 1, serverError: 1 },
    });
    expect(products?.latency.counts).toHaveLength(LATENCY_BUCKETS_V0);
    expect(sum(products?.latency.counts ?? [])).toBe(4);
    expect(products?.latency.max).toBe(950);
    expect(products?.latency.sum).toBeCloseTo(959.1, 3);
    const checkout = interval?.endpoints.find((e) => e.route === "/checkout");
    expect(checkout?.latency.counts[19]).toBe(1); // 350 ms → (300, 400]
  });

  it("returns null and resets when nothing was recorded", () => {
    const agg = new IntervalAggregator();
    expect(agg.rotate()).toBeNull();
    agg.record("GET", "/a", 200, 1);
    expect(agg.rotate()?.endpoints).toHaveLength(1);
    expect(agg.rotate()).toBeNull();
  });

  it("caps distinct routes per interval and folds the rest into (other)", () => {
    const agg = new IntervalAggregator(500);
    for (let i = 0; i < 600; i++) agg.record("GET", `/scan/${i}`, 404, 0.5);
    const interval = agg.rotate();
    expect(interval?.endpoints).toHaveLength(501);
    const other = interval?.endpoints.at(-1);
    expect(other?.route).toBe(OTHER_ROUTE);
    expect(other?.count).toBe(100);
    expect(sum(interval?.endpoints.map((e) => e.count) ?? [])).toBe(600);
  });

  it("handles 10 000 events in well under 50 ms", () => {
    const agg = new IntervalAggregator();
    const routes = ["/a", "/b/:id", "/c", "/d", "/e"];
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) agg.record("GET", routes[i % 5] ?? "/a", 200 + (i % 3) * 100, (i % 500) / 3);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(sum(agg.rotate()?.endpoints.map((e) => e.count) ?? [])).toBe(10_000);
  });
});
