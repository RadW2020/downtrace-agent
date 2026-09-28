/**
 * What the user asked not to be looked at.
 *
 * `product.md:104` gives the operator two controls over what leaves their server, and this is the first:
 * «the user can exclude endpoints or whole dependencies». Excluding is **not observing** — the
 * alternative, observing and then dropping, costs the same and buys nothing, because what the cloud needs
 * to know is *how many* are missing, and that is counted either way (gh-361, ADR 0101).
 *
 * The decision runs on every request and every dependency call, so it is answered from a map after the
 * first time: an application has a handful of routes and a handful of dependencies, and millions of
 * requests.
 */

import { labelBytes } from "./labels.ts";

/** Anything a regular expression would read as syntax, so it can be taken literally instead. */
const SYNTAX = /[.+?^${}()|[\]\\]/g;

/**
 * One pattern, where `*` stands for any run of characters and everything else is itself. The whole string
 * has to match.
 *
 * Not a regular expression from the user. A pattern of theirs on the hot path of every request cannot be
 * bounded — one backtracking pattern would hang the application it is supposed to be watching — and
 * invariant 3 is about exactly that.
 */
function matcher(pattern: string): RegExp {
  const literal = pattern.replace(SYNTAX, (c) => `\\${c}`);
  return new RegExp(`^${literal.split("*").join(".*")}$`);
}

/** Reads a comma-separated list. Blanks are dropped: an empty pattern would match nothing and read as all. */
export function patternsOf(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * How many decisions the cache keeps. What falls out of it is re-decided on the spot — the cost differs, the
 * answer is the same — the same as the fingerprint caches: a name per request is exactly the traffic that
 * would thrash an LRU (gh-765).
 */
export const DEFAULT_DECISIONS = 512;

/**
 * How many distinct excluded names the count keeps exact. A name per request that matches a pattern used to
 * add one for the life of the process (gh-765); at the cap the count saturates and is a lower bound, because
 * no bounded memory keeps counting distinct names past its bound.
 */
export const DEFAULT_EXCLUDED_NAMES = 512;

export interface ExcludedOptions {
  decisions?: number;
  excluded?: number;
}

/**
 * Decides once per distinct name and remembers, and counts how many distinct ones were actually excluded.
 *
 * The count is what the batch declares (ADR 0092), and it is deliberately of names **seen and dropped** and
 * not of patterns configured: the question a reader has is «how many are missing from these numbers», and
 * a pattern that matches nothing is not missing from anything.
 *
 * Both memories are bounded (invariant 3, gh-765): the decisions by a cap, the count by its own. What falls
 * out of the decisions is re-decided; what is past the cap of the count is a lower bound, not a count.
 */
export class Excluded {
  private readonly patterns: RegExp[];
  /** The decisions a lookup answers from memory. Bounded; when it is full, names are decided on the spot. */
  private readonly decided = new Map<string, boolean>();
  private readonly decisionsCap: number;
  /** The distinct names really excluded: what the count is, and why it is exact while it fits. */
  private readonly excluded = new Set<string>();
  private readonly excludedCap: number;
  private excludedCount = 0;

  constructor(patterns: string[], options: ExcludedOptions = {}) {
    this.patterns = patterns.map(matcher);
    this.decisionsCap = options.decisions ?? DEFAULT_DECISIONS;
    this.excludedCap = options.excluded ?? DEFAULT_EXCLUDED_NAMES;
  }

  get configured(): boolean {
    return this.patterns.length > 0;
  }

  /**
   * How many distinct names have been excluded so far. Zero until one actually turns up; exact until the set
   * of names saturates, a lower bound from there (gh-765).
   */
  get count(): number {
    return this.excludedCount;
  }

  has(name: string): boolean {
    if (this.patterns.length === 0) return false;
    const known = this.decided.get(name);
    if (known !== undefined) return known;
    const excluded = this.patterns.some((p) => p.test(name));
    // Counted once per distinct name: the set says whether this one was already counted, while it fits.
    if (excluded && !this.excluded.has(name) && this.excluded.size < this.excludedCap) {
      this.excluded.add(name);
      this.excludedCount += 1;
    }
    if (this.decided.size < this.decisionsCap) this.decided.set(name, excluded);
    return excluded;
  }

  /**
   * What the decisions and the count hold, by the same arithmetic the registers publish (ADR 0067, gh-765).
   * A name in both is counted in both: the overcount is in the safe direction.
   */
  bytes(): number {
    let total = 0;
    for (const name of this.decided.keys()) total += labelBytes(name.length);
    for (const name of this.excluded) total += labelBytes(name.length);
    return total;
  }
}
