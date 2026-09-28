/**
 * One case for each rule the heuristic of `src/routes.ts` asks of a segment of a route without a template
 * (gh-756).
 *
 * A segment that carries a value — an email, a token, a phone, a file name with a number — used to leave
 * the server whole in every batch, once per request, and that is invariant 5. So these are the plainest
 * values a segment can be and still be caught, each chosen so that its rule decides what the segment
 * becomes and no other rule does: the same discipline as the sanitiser's cases (ADR 0167), because a rule
 * that no case depends on is a rule that can be deleted without anyone noticing, which is what gh-651 found.
 *
 * **Which rule decides which case is not written here.** `sanitize.test.ts` computes it by taking each rule
 * out of the source's own list and running the real loop without it, and it fails when a case is decided by
 * more than one rule or by none, and when a rule decides none of these. A rule added without its case is
 * that last red.
 */
export interface SegmentCase {
  /** The segment as a request's path carries it. */
  segment: string;
  /** The part of it that is a value, and that must never leave the server. */
  value: string;
}

export const SEGMENT_CASES: readonly SegmentCase[] = [
  // An email: the `@` is the tell, and nothing else says it is a value.
  { segment: "ana@cliente.com", value: "ana@cliente.com" },
  // A handle with no dot after the `@`: the sanitiser's email rule would not take it, and in a segment the
  // `@` alone is enough.
  { segment: "@alice", value: "@alice" },
  // A percent that is not even a valid escape: a `%` in a path is how a client writes what it cannot, and
  // nothing else of the segment gives it away.
  { segment: "discount%", value: "discount%" },
  // A phone: a run of digits with a sign, which no other rule reads.
  { segment: "+34600111222", value: "+34600111222" },
  // A token with no digit in it: a mixed-case run long enough that a name would not write it that way.
  { segment: "ZxkQvNpLmRtYwBqHsJdF", value: "ZxkQvNpLmRtYwBqHsJdF" },
  // A UUID made only of the letters of its own class: no digit for the digit rule, no uppercase for the
  // mixed-case run, so this is the shape only the UUID rule reads.
  { segment: "abcdefab-cdef-abcd-abcd-abcdefabcdef", value: "abcdefab-cdef-abcd-abcd-abcdefabcdef" },
  // And a run of hex the same way: 24 characters of the hex class with no digit and no uppercase.
  { segment: "abcdefabcdefabcdefabcdef", value: "abcdefabcdefabcdefabcdef" },
];
