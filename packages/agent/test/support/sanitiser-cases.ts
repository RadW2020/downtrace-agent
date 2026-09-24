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

  // Quotes that are not ASCII's, one family per rule, each opened by any of its languages' marks and left open once
  // (gh-684). English and German double quotes close with the same two marks.
  { message: "user “alice” not found", value: "alice", sanitised: "user ? not found" },
  { message: "user „alice“ not found", value: "alice", sanitised: "user ? not found" },
  { message: "user “alice not found", value: "alice", sanitised: "user ?" },
  { message: "user ‘alice’ not found", value: "alice", sanitised: "user ? not found" },
  { message: "user ‚alice‘ not found", value: "alice", sanitised: "user ? not found" },
  { message: "user ‘alice not found", value: "alice", sanitised: "user ?" },
  { message: "user «alice» not found", value: "alice", sanitised: "user ? not found" },
  { message: "user »alice« not found", value: "alice", sanitised: "user ? not found" },
  { message: "user «alice not found", value: "alice", sanitised: "user ?" },
  { message: "user 「alice」 not found", value: "alice", sanitised: "user ? not found" },
  { message: "user 『alice』 not found", value: "alice", sanitised: "user ? not found" },
  { message: "user 「alice not found", value: "alice", sanitised: "user ?" },
  // A backtick is a quote too, although it is how Prisma and MySQL name a field (ADR 0170).
  { message: "user `alice` not found", value: "alice", sanitised: "user ? not found" },
  { message: "user `alice not found", value: "alice", sanitised: "user ?" },

  // A URL keeps its scheme and a plain host, the shape a dependency target already travels in, and loses its path and
  // its query, which is where the parameters are. This is the message `node-fetch` builds.
  {
    message: "request to https://api.example.com/users/alice?name=alice failed",
    value: "alice",
    sanitised: "request to https://api.example.com/? failed",
  },
  // And an authority with anything but a host in it goes whole. Without this rule the email rule takes the password
  // and the host, and leaves the user.
  {
    message: "could not connect to postgres://payroll:hunter@db.internal/orders",
    value: "payroll",
    sanitised: "could not connect to postgres://?",
  },

  // A path with no scheme in front of it, and a file path: a word with a `/` or a `\` in it goes whole, because its
  // segments are the names of things and a plain word is all a segment needs to be (gh-697). Each of these left the
  // server whole before, the query of the first one included.
  { message: "no route for /users/alice?name=alice", value: "alice", sanitised: "no route for ?" },
  // The directory of a file gives away the `$HOME` of whoever runs it, on either system's separator.
  { message: "cannot read /home/alice/orders.csv", value: "alice", sanitised: "cannot read ?" },
  { message: "cannot read C:\\Users\\alice\\orders.csv", value: "alice", sanitised: "cannot read ?" },
  // A relative path has no root to recognise it by, only its separator.
  { message: "cannot read uploads/alice/orders.csv", value: "alice", sanitised: "cannot read ?" },
  // And a host with no scheme goes with its path: without a scheme nothing says the first segment is a host.
  { message: "GET api.example.com/users/alice failed", value: "alice", sanitised: "GET ? failed" },

  // Letters, marks and digits of every script. Each of these is a value the ASCII reading of `\w`, `\d` and `\b` let
  // out whole: the address is cut at its accent before the `@` or before the dot, the digits are not digits, and the
  // long run is split at each accent into pieces too short to be one.
  { message: "could not send to josé@cliente.com", value: "josé@cliente.com", sanitised: "could not send to ?" },
  { message: "could not send to ana@müller.de", value: "ana@müller.de", sanitised: "could not send to ?" },
  // The same `é`, decomposed: an `e` and a combining accent, which is how a name typed on some systems arrives.
  {
    message: "could not send to rené@cliente.com",
    value: "rené@cliente.com",
    sanitised: "could not send to ?",
  },
  { message: "user ４８２１ not found", value: "４８２１", sanitised: "user ? not found" },
  { message: "user ٤٨٢١ not found", value: "٤٨٢١", sanitised: "user ? not found" },
  {
    message: "no account with handle álvaro_garcía_marketing",
    value: "álvaro_garcía_marketing",
    sanitised: "no account with handle ?",
  },
  // And decomposed, a word with a digit and a long run are one word each, accents and all: a class without the marks
  // would stop at each accent and leave the name in front of it.
  { message: "no invoice for josé4821", value: "josé", sanitised: "no invoice for ?" },
  {
    message: "no account with handle martínez_lópez_marketing",
    value: "martínez_lópez_marketing",
    sanitised: "no account with handle ?",
  },
];
