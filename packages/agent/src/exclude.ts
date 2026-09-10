/**
 * What the user asked not to be looked at.
 *
 * `product.md:104` gives the operator two controls over what leaves their server, and this is the first:
 * «el usuario puede excluir endpoints o dependencias completas». Excluding is **not observing** — the
 * alternative, observing and then dropping, costs the same and buys nothing, because what the cloud needs
 * to know is *how many* are missing, and that is counted either way (gh-361, ADR 0101).
 *
 * The decision runs on every request and every dependency call, so it is answered from a map after the
 * first time: an application has a handful of routes and a handful of dependencies, and millions of
 * requests.
 */

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
 * Decides once per distinct name and remembers, and counts how many distinct ones were actually excluded.
 *
 * The count is what the batch declares (ADR 0092), and it is deliberately of names **seen and dropped** and
 * not of patterns configured: the question a reader has is «how many are missing from these numbers», and
 * a pattern that matches nothing is not missing from anything.
 */
export class Excluded {
  private readonly patterns: RegExp[];
  private readonly decided = new Map<string, boolean>();
  private excludedCount = 0;

  constructor(patterns: string[]) {
    this.patterns = patterns.map(matcher);
  }

  get configured(): boolean {
    return this.patterns.length > 0;
  }

  /** How many distinct names have been excluded so far. Zero until one actually turns up. */
  get count(): number {
    return this.excludedCount;
  }

  has(name: string): boolean {
    if (this.patterns.length === 0) return false;
    const known = this.decided.get(name);
    if (known !== undefined) return known;
    const excluded = this.patterns.some((p) => p.test(name));
    this.decided.set(name, excluded);
    if (excluded) this.excludedCount += 1;
    return excluded;
  }
}
