import { describe, expect, it } from "vitest";
import { buildPlan, DEFAULT_MIX, ENDPOINTS } from "../src/load.ts";
import { percentile, percentiles } from "../src/stats.ts";
import { must } from "./helpers.ts";

describe("buildPlan", () => {
  it("produces the identical request sequence for the same seed", () => {
    expect(JSON.stringify(buildPlan(1, 500))).toBe(JSON.stringify(buildPlan(1, 500)));
    expect(JSON.stringify(buildPlan(1, 500))).not.toBe(JSON.stringify(buildPlan(2, 500)));
  });

  it("follows the mix within 3 points over a large plan", () => {
    const plan = buildPlan(42, 20_000);
    const total = Object.values(DEFAULT_MIX).reduce((a, b) => a + b, 0);
    for (const e of ENDPOINTS) {
      const share = (plan.filter((p) => p.endpoint === e).length / plan.length) * 100;
      expect(Math.abs(share - (DEFAULT_MIX[e] / total) * 100)).toBeLessThan(3);
    }
  });

  it("builds well-formed requests", () => {
    const plan = buildPlan(3, 200);
    const checkout = must(
      plan.find((p) => p.endpoint === "POST /checkout"),
      "checkout request",
    );
    expect(checkout.method).toBe("POST");
    expect(JSON.parse(must(checkout.body, "checkout body"))).toMatchObject({
      userId: expect.any(Number),
      items: expect.any(Array),
    });
    const me = must(
      plan.find((p) => p.endpoint === "GET /me"),
      "me request",
    );
    expect(me.headers?.["x-user-id"]).toMatch(/^[1-5]$/);
    const product = must(
      plan.find((p) => p.endpoint === "GET /products/:id"),
      "product request",
    );
    expect(product.path).toMatch(/^\/products\/([1-9]|[1-4][0-9]|50)$/);
  });
});

describe("percentiles", () => {
  it("uses nearest rank", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentiles([5, 1, 3]).max).toBe(5);
    expect(percentiles([]).p99).toBe(0);
  });
});
