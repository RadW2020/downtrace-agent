import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/prng.ts";
import { roundDrift, standardDeviation, tQuantile975 } from "../src/stats.ts";

/**
 * The noise estimate used to be max − min of the baseline rounds. A range never shrinks when a round is added and
 * grows with the count of rounds by construction, so the documented cure for a large noise —more rounds— made the
 * reported noise larger: nine rounds reported more noise than three in five campaigns out of five (gh-571).
 *
 * These tests pin the estimator's behaviour as n varies, not only its value in one case (ADR 0137).
 */
const draw = (seed: number, n: number, sd = 1, mean = 20): number[] => {
  const rand = mulberry32(seed);
  // Box–Muller from the seeded PRNG: the same n draws for the same seed, whatever else runs.
  return Array.from({ length: n }, () => {
    const u = Math.max(rand(), Number.EPSILON);
    const v = rand();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  });
};
const range = (a: readonly number[]) => Math.max(...a) - Math.min(...a);

describe("the drift between rounds, as a standard error and not a range", () => {
  it("is smaller at nine rounds than at three, on rounds drawn from one distribution", () => {
    const rounds = draw(7, 9);
    expect(roundDrift(rounds.slice(0, 9))).toBeLessThan(roundDrift(rounds.slice(0, 3)));
  });

  it("does not grow when rounds from the same distribution are added, where the range only ever grows", () => {
    // Fifty draws of the experiment: the range at 9 is never below the range at 3 (it cannot be); the drift at 9
    // is below the drift at 3 in the great majority, and never more than the t factor's own shrinking allows.
    let driftGrew = 0;
    let rangeShrank = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const rounds = draw(seed, 9);
      if (roundDrift(rounds) > roundDrift(rounds.slice(0, 3))) driftGrew++;
      if (range(rounds) < range(rounds.slice(0, 3))) rangeShrank++;
    }
    expect(rangeShrank).toBe(0);
    expect(driftGrew).toBeLessThan(5);
  });

  it("shrinks like √n once the t factor has settled: sixteen rounds resolve about twice what four do", () => {
    const a = [19, 21, 19, 21];
    const b = [19, 21, 19, 21, 19, 21, 19, 21, 19, 21, 19, 21, 19, 21, 19, 21];
    const four = roundDrift(a);
    const sixteen = roundDrift(b);
    // The moving parts are t(n−1), √(2/n) and the n−1 in the standard deviation; nothing else.
    const expectedRatio =
      (tQuantile975(3) * standardDeviation(a) * Math.sqrt(2 / 4)) /
      (tQuantile975(15) * standardDeviation(b) * Math.sqrt(2 / 16));
    expect(four / sixteen).toBeCloseTo(expectedRatio, 9);
    expect(four / sixteen).toBeGreaterThan(2.5); // the t factor makes four rounds worth less than half of sixteen
  });

  it("is t · sd · √(2/n) exactly", () => {
    const rounds = [24.0, 24.42, 24.238];
    expect(roundDrift(rounds)).toBeCloseTo(4.303 * standardDeviation(rounds) * Math.sqrt(2 / 3), 9);
  });

  it("is zero when the machine did not move at all", () => {
    expect(roundDrift([20, 20, 20, 20])).toBe(0);
  });

  it("cannot be estimated from fewer than two rounds", () => {
    expect(roundDrift([20])).toBe(Number.POSITIVE_INFINITY);
    expect(roundDrift([])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Student's t at 97.5 %", () => {
  it("is the tabulated value up to thirty degrees of freedom and stays at the last one beyond", () => {
    expect(tQuantile975(1)).toBe(12.706);
    expect(tQuantile975(2)).toBe(4.303);
    expect(tQuantile975(8)).toBe(2.306);
    expect(tQuantile975(30)).toBe(2.042);
    // Never less conservative than the table, and no jump: 2.042 rather than the 1.96 of infinite freedom.
    expect(tQuantile975(31)).toBe(2.042);
    expect(tQuantile975(1000)).toBe(2.042);
  });

  it("is infinite with no degrees of freedom: nothing can be said from one value", () => {
    expect(tQuantile975(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("decreases with the degrees of freedom", () => {
    for (let df = 1; df < 31; df++) expect(tQuantile975(df + 1)).toBeLessThanOrEqual(tQuantile975(df));
  });
});
