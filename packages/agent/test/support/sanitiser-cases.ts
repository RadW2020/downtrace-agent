/**
 * One case for each rule of `src/sanitize.ts`, each chosen so that its rule decides what comes out and no other
 * rule does (gh-651).
 *
 * Every hostile message the tests had before carried a digit or an email besides whatever it was written for, so
 * a rule could be deleted and another one still caught its case: the quoted spans could go, and
 * `user 'alice' not found` left the server whole. So these are the plainest a value can be and still be caught —
 * a first name between quotes, a handle with no digit in it —, which is exactly what only one rule can catch.
 *
 * **Which rule decides which case is not written here.** `sanitize.test.ts` computes it by taking each rule out of
 * the source's own list and running the real loop without it, and it fails when a case is decided by more than one
 * rule or by none, and when a rule decides none of these. A rule added without its case is that last red.
 *
 * Shared because a message leaves by more than one door — the message of a thrown error, a value of the context of
 * `captureException`, and the bytes of a batch — and a case added here reaches all of them.
 */
export interface SanitiserCase {
  /** What the application wrote. */
  message: string;
  /** The part of it that is a value, and that must never leave the server. */
  value: string;
  /** What `sanitizeMessage` leaves of it, exactly. */
  sanitised: string;
}

const UUID = "5b6d1f0e-2c3a-4d5e-8f90-1a2b3c4d5e6f";

export const SANITISER_CASES: readonly SanitiserCase[] = [
  // A first name is a plain word: only the quotes say it is what the sentence is about.
  { message: "user 'alice' not found", value: "alice", sanitised: "user ? not found" },
  // And a quote that never closes takes the rest of the message, or a malformed string would leave whole.
  { message: "user 'alice not found", value: "alice", sanitised: "user ?" },
  {
    message: 'invalid input syntax for type uuid: "alice"',
    value: "alice",
    sanitised: "invalid input syntax for type uuid: ?",
  },
  {
    message: 'invalid input syntax for type uuid: "alice',
    value: "alice",
    sanitised: "invalid input syntax for type uuid: ?",
  },
  {
    message: "could not send to ana.perez@cliente.com",
    value: "ana.perez@cliente.com",
    sanitised: "could not send to ?",
  },
  // And one with a digit in it, which is the order of the rules as much as the rule: were the digit rule to run
  // first it would take `ana4` and leave `?@cliente.com`, where no rule sees an address any more.
  { message: "could not send to ana4@cliente.com", value: "cliente.com", sanitised: "could not send to ?" },
  // An identifier made only of letters and underscores: nothing but its length gives it away.
  {
    message: "no account with handle alice_smith_marketing",
    value: "alice_smith_marketing",
    sanitised: "no account with handle ?",
  },
  { message: "user 4821 not found", value: "4821", sanitised: "user ? not found" },
  // The one rule that stands between no value and the wire: the long run takes a UUID whole too, hyphens and all.
  // What only this rule decides is the word glued to it, which it leaves and the long run would take (ADR 0167).
  { message: `lock order-${UUID} is held`, value: UUID, sanitised: "lock order-? is held" },
];
