/**
 * What a value looks like, decided once.
 *
 * Two places in this package have to look at text written by somebody else and decide how much of it may
 * leave the user's server: the message of a thrown error, and the name inside a double-quoted SQL identifier.
 * They are not the same kind of text, but the question is the same one — «is this a value?» — and a rule with
 * two copies is a rule that will disagree with itself (gh-350).
 *
 * It lives here and not in `errors.ts` because `fingerprint.ts` needs it too, and `errors.ts` already imports
 * `hash64` from there.
 */

/**
 * How much of a sanitised message has to still be words for it to be worth sending.
 *
 * `product.md:104`: «when something cannot be processed with guarantees, it is omitted rather than risked: (…) an
 * error message that does not fit the known formats travels only as type and signature, without text».
 *
 * There is no catalogue of «known formats» to check against, and there does not need to be one: the signal is
 * how much sense survives the sanitising. A message that comes out mostly `?` tells a reader nothing and only
 * risks whatever the patterns did not catch. Half is generous **towards omitting**, which is the criterion the
 * product states (gh-343).
 */
const MIN_MEANING = 0.5;

/**
 * A letter, a mark or a digit of any script: what `\w` means, less its `_`, once a message is not written in ASCII.
 *
 * JavaScript keeps `\w`, `\d` and `\b` ASCII even with the `u` flag, so `josé@cliente.com` was cut at its accent
 * before the `@` and `４８２１` was not a number (gh-684). The marks are in because a name typed in decomposed form
 * is an `e` followed by a combining accent, and a class without them cuts it in the same place. Written once, so that
 * every pattern below reads a word the same way.
 */
const ALNUM = String.raw`\p{L}\p{M}\p{N}`;
/** A character of a word, as `\w` would be. */
const WORD = `[${ALNUM}_]`;
/** And `\b` under that meaning of a word: where a word character meets something that is not one. */
const EDGE = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/**
 * Anything that looks like a value. Order matters three times. A URL runs first, because the email rule would take
 * the password and the host of `postgres://payroll:hunter@db.internal` and leave the user. An email runs before
 * the rest, because a rule that took part of it would leave the rest where no rule sees an address any more:
 * `ana4@cliente.com` would come out as `?@cliente.com`. And a UUID runs before the long run, for the reason given
 * beside it.
 *
 * Deliberately eager. A false positive costs a `?` where a word would have read better; a false negative
 * puts a customer's identifier in a batch, and there is no taking that back.
 *
 * The patterns that read words are the ones they were with `\w`, `\d` and `\b` read in every script, and nothing
 * else: on a message made only of ASCII each matches exactly what it matched before, so the identity of such an
 * error does not move, and `sanitize.test.ts` checks it against the rules as they were (ADR 0170).
 *
 * Each of these, and each quoted span below, decides a case that no other rule does, and `sanitize.test.ts`
 * checks it by taking each one out of this very list (gh-651). A rule added here needs its case.
 */
export const VALUE_PATTERNS: readonly RegExp[] = [
  // What a URL carries after its host: the path, the query and the fragment, where the parameters are. The scheme
  // stays, and so do the host and its port when the authority is nothing else, because that is the shape a
  // dependency target already travels in. An authority that is anything else — a user and a password, a password
  // with a `/` in it, an IPv6 literal — goes whole with the rest, rather than a rule guessing where a credential
  // ends. The host is still read by the rules below, as any word is (ADR 0170).
  /(?<=:\/\/)(?![^\s/?#@:]*(?::\d*)?(?:[\s/?#]|$))\S+|(?<=:\/\/[^\s/?#@:]*(?::\d*)?[/?#])\S+/g,
  // Emails before anything splits them.
  new RegExp(String.raw`[${ALNUM}_.+-]+@[${ALNUM}_-]+\.[${ALNUM}_.-]+`, "gu"),
  // UUIDs. The long run below takes a UUID whole as well, hyphens and all, so this one hides nothing that one
  // does not: what it decides is the word glued to it, `order-?` where the long run would leave `?`. It stays
  // for that, because taking it out would change the identity of every error and name that carries one
  // (ADR 0167). A UUID is hex by definition, so its class stays ASCII.
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // Any long run of letters, digits, `_` and `-`: tokens, hashes, ids, and a handle written with an accent.
  new RegExp(`${EDGE}[${ALNUM}_-]{16,}${EDGE}`, "gu"),
  // Anything with a digit in it, of any script. A word that carries a number is a value or a version, and neither
  // belongs in an identity.
  new RegExp(String.raw`${EDGE}${WORD}*\p{N}[${ALNUM}_.]*${EDGE}`, "gu"),
];

/**
 * Quoted spans, including an unterminated one — the same reasoning as the SQL scanner: a pattern that requires the
 * closing quote lets a malformed string through whole.
 *
 * One rule per family of quotes, each opened by any of its languages' opening marks and closed by either of its
 * marks: `„alice“` is German and closes with the mark `“alice”` opens with. Not one rule for every quote, which would
 * stop `“it’s alice”` at the apostrophe and let `alice` out; and `’` opens nothing, because it is also the apostrophe
 * of `can’t`. A backtick is a quote too, although Prisma and MySQL name a field with it: the same character carries a
 * value in other messages, and `(?)` is the cost ADR 0083 already accepted for `relation "users"` (ADR 0170).
 *
 * Separate from the list above because they only mean «value» **in prose**. In an error message, what is
 * between quotes is the thing the message is about. Inside a SQL identifier there is nothing to quote: the
 * whole name is already between quotes, and a `"` in there is a character of the name (gh-350).
 */
const QUOTED_SPANS: readonly RegExp[] = [
  /'[^']*'?/g,
  /"[^"]*"?/g,
  /[“„][^“”]*[“”]?/g,
  /[‘‚][^‘’]*[‘’]?/g,
  /[«»][^«»]*[«»]?/g,
  /[「『][^」』]*[」』]?/g,
  /`[^`]*`?/g,
];

/** Every rule a sentence goes through, in the order it does: first what it put between quotes, then the rest. */
export const MESSAGE_RULES: readonly RegExp[] = [...QUOTED_SPANS, ...VALUE_PATTERNS];

/** A run of values separated by nothing but punctuation is one value as far as identity goes: «expected 1,
 * 2, 3» and «expected 4, 5» are the same error, and leaving three question marks would make them two. */
const collapse = (out: string): string =>
  out
    .replace(/\?(\s*[,;:]?\s*\?)+/g, "?")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Replaces whatever each of `rules` matches, in order, then collapses what is left.
 *
 * The one loop both functions below run. Exported so that a test can run it with one rule taken out and see what
 * that rule decides, rather than run a copy of it that could drift from this one.
 */
export function sanitizeWith(text: string, rules: readonly RegExp[]): string {
  let out = text;
  for (const rule of rules) out = out.replace(rule, "?");
  return collapse(out);
}

/** Replaces everything that is a value wherever it appears. For text that is a name and not a sentence. */
export function sanitizeValues(text: string): string {
  return sanitizeWith(text, VALUE_PATTERNS);
}

/** The same, plus what is only a value in prose: whatever the sentence put between quotes. */
export function sanitizeMessage(message: string): string {
  return sanitizeWith(message, MESSAGE_RULES);
}

/**
 * Whether a sanitised message still says something.
 *
 * Counted in words and not in characters: `?` is one character and the word it replaced was ten, so counting
 * characters would call a message meaningful precisely when it lost the most.
 */
export function meaningful(sanitised: string): boolean {
  if (sanitised === "") return false;
  const words = sanitised.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return false;
  const kept = words.filter((w) => w.replace(/[^A-Za-z]/g, "").length > 0).length;
  return kept / words.length >= MIN_MEANING;
}
