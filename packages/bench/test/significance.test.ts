import { describe, expect, it } from "vitest";
import { EXACT_LIMIT, gate, permutationP, roundsToResolve, smallestP } from "../src/significance.ts";

describe("permutationP", () => {
  it("gives the smallest possible p when every difference points the same way", () => {
    const differences = [1.1, 0.4, 2.7, 0.9, 1.5, 3.2, 0.8, 1.9, 2.1];
    const result = permutationP(differences, { seed: 1 });
    expect(result.exact).toBe(true);
    // Only the observed assignment and its mirror reach this mean: 2 of 2^9.
    expect(result.p).toBeCloseTo(2 / 512, 10);
  });

  it("does not care how big the differences are, only how consistent", () => {
    const small = permutationP([0.001, 0.002, 0.003, 0.001, 0.002], { seed: 1 });
    const huge = permutationP([100, 200, 300, 100, 200], { seed: 1 });
    expect(small.p).toBe(huge.p);
  });

  it("finds nothing in differences that cancel out", () => {
    const result = permutationP([1, -1, 2, -2, 3, -3], { seed: 1 });
    expect(result.p).toBe(1);
  });

  it("finds nothing in a single large difference among noise", () => {
    // One round went wrong. That is not a measurement, and the gate must not call it one.
    const result = permutationP([5, -0.1, 0.1, -0.2, 0.2, -0.1, 0.1, -0.2, 0.2], { seed: 1 });
    expect(result.p).toBeGreaterThan(0.05);
  });

  it("samples above the exact limit, reproducibly", () => {
    const differences = Array.from({ length: EXACT_LIMIT + 1 }, (_, i) => 1 + (i % 3) * 0.1);
    const a = permutationP(differences, { seed: 7 });
    const b = permutationP(differences, { seed: 7 });
    const c = permutationP(differences, { seed: 8 });
    expect(a.exact).toBe(false);
    expect(a.p).toBe(b.p);
    expect(a.p).toBeGreaterThan(0);
    expect(c.exact).toBe(false);
  });

  it("has no opinion without differences", () => {
    expect(permutationP([], { seed: 1 }).p).toBe(1);
    expect(permutationP([1], { seed: 1 }).p).toBe(1);
  });
});

describe("gate", () => {
  // The five rows of the nine-round run that motivated gh-187, as mean and standard error.
  // Reconstructed as differences with that mean and that spread, all of one sign.
  const rowsAsDifferences = (mean: number, stderr: number, n: number): number[] => {
    const sd = stderr * Math.sqrt(n);
    // A symmetric fan around the mean with the required spread: -k, 0, +k pattern scaled.
    const raw = Array.from({ length: n }, (_, i) => i - (n - 1) / 2);
    const rawSd = Math.sqrt(raw.reduce((a, v) => a + v * v, 0) / (n - 1));
    return raw.map((v) => mean + (v / rawSd) * sd);
  };

  it("resolves nothing from the run that motivated this ticket", () => {
    const rows = [
      { name: "the agent itself", mean: 0.592, stderr: 0.206 },
      { name: "runtime health", mean: -0.122, stderr: 0.346 },
      { name: "postgres", mean: 0.795, stderr: 0.328 },
      { name: "outgoing HTTP", mean: 0.035, stderr: 0.229 },
      { name: "redis", mean: 0.487, stderr: 0.217 },
    ];
    for (const row of rows) {
      const differences = rowsAsDifferences(row.mean, row.stderr, 9);
      const { resolved } = gate(permutationP(differences, { seed: 1 }).p, rows.length);
      expect(resolved, row.name).toBe(false);
    }
  });

  it("shares the level across the comparisons of the run", () => {
    expect(gate(0.009, 5).alpha).toBeCloseTo(0.01, 10);
    expect(gate(0.009, 5).resolved).toBe(true);
    expect(gate(0.011, 5).resolved).toBe(false);
    expect(gate(0.011, 1).resolved).toBe(true);
  });
});

describe("smallestP and roundsToResolve", () => {
  it("knows what nine rounds can reach", () => {
    expect(smallestP(9)).toBeCloseTo(2 / 512, 10);
  });

  it("says five rounds cannot resolve five comparisons, however clean the machine", () => {
    // 2/2^5 = 0.0625, and the gate for five comparisons is 0.01. No data can pass it.
    expect(smallestP(5)).toBeGreaterThan(gate(1, 5).alpha);
    expect(roundsToResolve(5)).toBe(8);
  });

  it("says how many rounds would be enough", () => {
    expect(smallestP(roundsToResolve(5))).toBeLessThan(gate(1, 5).alpha);
    expect(smallestP(roundsToResolve(1))).toBeLessThan(gate(1, 1).alpha);
  });
});
