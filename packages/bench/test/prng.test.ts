import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/prng.ts";

describe("mulberry32", () => {
  it("is deterministic for a seed and different across seeds", () => {
    const a = mulberry32(7),
      b = mulberry32(7),
      c = mulberry32(8);
    const sa = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(sa);
  });

  it("yields values in [0, 1)", () => {
    const r = mulberry32(1);
    for (let i = 0; i < 10_000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
