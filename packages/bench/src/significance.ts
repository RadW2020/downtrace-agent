import { mulberry32 } from "./prng.ts";

/**
 * Whether a measured difference is a measurement or the machine having a moment.
 *
 * The observer split compares several agent configurations in one run, so it faces two problems that a single
 * comparison does not. It runs few rounds, which rules out any criterion that only holds for many; and it makes
 * several comparisons at once, so the chance that one of them looks resolved by accident is several times the
 * chance for one.
 *
 * Both are answered here. Significance comes from a permutation test over the signs of the paired differences:
 * rounds alternate in time, so under the hypothesis that an observer costs nothing, which side of each pair came
 * out higher is a coin flip. Enumerating every reassignment of signs gives an exact p with no assumption about
 * the shape of the distribution — benchmark differences are not normal and there is no reason to pretend. The
 * level is then divided by the number of comparisons the run makes.
 */

/** Above this many differences, 2^n reassignments stop being worth enumerating and get sampled instead. */
export const EXACT_LIMIT = 20;

/** Reassignments drawn when there are too many to enumerate. */
const SAMPLES = 200_000;

/** The conventional level, before it is shared out among the comparisons of a run. */
const ALPHA = 0.05;

export interface Significance {
  p: number;
  /** False when the p value was sampled rather than enumerated. */
  exact: boolean;
}

/**
 * Two-sided p for "these paired differences are centred on zero", from the signs alone.
 *
 * The statistic is the absolute mean. With fewer than two differences there is nothing to permute and the
 * answer is 1: no evidence, which is the honest reading of one round.
 */
export function permutationP(differences: readonly number[], opts: { seed: number }): Significance {
  const n = differences.length;
  if (n < 2) return { p: 1, exact: true };
  const observed = Math.abs(sum(differences)) / n;
  // Compared as sums to keep the division out of the inner loop; the divisor is the same on both sides.
  const threshold = observed * n - 1e-12;

  if (n <= EXACT_LIMIT) {
    let atLeast = 0;
    const total = 2 ** n;
    for (let mask = 0; mask < total; mask++) {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += (mask & (1 << i)) === 0 ? (differences[i] ?? 0) : -(differences[i] ?? 0);
      if (Math.abs(acc) >= threshold) atLeast++;
    }
    return { p: atLeast / total, exact: true };
  }

  const random = mulberry32(opts.seed);
  let atLeast = 0;
  for (let s = 0; s < SAMPLES; s++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += random() < 0.5 ? (differences[i] ?? 0) : -(differences[i] ?? 0);
    if (Math.abs(acc) >= threshold) atLeast++;
  }
  // The observed assignment is one of the possible ones, so it is counted on both sides: a sampled p is never 0,
  // because "we did not draw it" is not the same as "it cannot happen".
  return { p: (atLeast + 1) / (SAMPLES + 1), exact: false };
}

export interface Gate {
  alpha: number;
  resolved: boolean;
}

/** The level a run of `comparisons` comparisons has to clear, and whether this p clears it (Bonferroni). */
export function gate(p: number, comparisons: number): Gate {
  const alpha = ALPHA / Math.max(1, comparisons);
  return { alpha, resolved: p < alpha };
}

/**
 * The smallest p that `n` paired differences can produce: the observed assignment and its mirror, out of 2^n.
 *
 * Worth knowing before measuring. With too few rounds no result can clear the gate however clean the machine,
 * and an hour of benchmark that could not have resolved anything is an hour spent proving nothing.
 */
export function smallestP(n: number): number {
  if (n < 2) return 1;
  return 2 / 2 ** Math.min(n, EXACT_LIMIT);
}

/** The fewest rounds per side at which a run of `comparisons` comparisons could resolve anything. */
export function roundsToResolve(comparisons: number): number {
  const alpha = gate(1, comparisons).alpha;
  for (let n = 2; n <= EXACT_LIMIT; n++) if (smallestP(n) < alpha) return n;
  return EXACT_LIMIT;
}

function sum(values: readonly number[]): number {
  let acc = 0;
  for (const v of values) acc += v;
  return acc;
}
