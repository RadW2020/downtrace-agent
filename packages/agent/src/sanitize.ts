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
 * `product.md:104`: «cuando algo no puede procesarse con garantías, **se omite en lugar de arriesgarse**: […]
 * un mensaje de error que no encaja en los formatos conocidos viaja solo como tipo y firma, sin texto».
 *
 * There is no catalogue of «known formats» to check against, and there does not need to be one: the signal is
 * how much sense survives the sanitising. A message that comes out mostly `?` tells a reader nothing and only
 * risks whatever the patterns did not catch. Half is generous **towards omitting**, which is the criterion the
 * product states (gh-343).
 */
const MIN_MEANING = 0.5;

/**
 * Anything that looks like a value. Order matters: the wider patterns run first so a UUID is not eaten as
 * three separate hex runs.
 *
 * Deliberately eager. A false positive costs a `?` where a word would have read better; a false negative
 * puts a customer's identifier in a batch, and there is no taking that back.
 */
const VALUE_PATTERNS: RegExp[] = [
  // Emails before anything splits them.
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // UUIDs, then any long hex or base64-ish run: tokens, hashes, ids.
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\b[0-9a-zA-Z_-]{16,}\b/g,
  // Anything with a digit in it. A word that carries a number is a value or a version, and neither belongs
  // in an identity.
  /\b\w*\d[\w.]*\b/g,
];

/**
 * Quoted spans, single or double, including an unterminated one — the same reasoning as the SQL scanner: a
 * pattern that requires the closing quote lets a malformed string through whole.
 *
 * Separate from the list above because they only mean «value» **in prose**. In an error message, what is
 * between quotes is the thing the message is about. Inside a SQL identifier there is nothing to quote: the
 * whole name is already between quotes, and a `"` in there is a character of the name (gh-350).
 */
const QUOTED_SPANS: RegExp[] = [/'[^']*'?/g, /"[^"]*"?/g];

/** A run of values separated by nothing but punctuation is one value as far as identity goes: «expected 1,
 * 2, 3» and «expected 4, 5» are the same error, and leaving three question marks would make them two. */
const collapse = (out: string): string =>
  out
    .replace(/\?(\s*[,;:]?\s*\?)+/g, "?")
    .replace(/\s+/g, " ")
    .trim();

/** Replaces everything that is a value wherever it appears. For text that is a name and not a sentence. */
export function sanitizeValues(text: string): string {
  let out = text;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, "?");
  return collapse(out);
}

/** The same, plus what is only a value in prose: whatever the sentence put between quotes. */
export function sanitizeMessage(message: string): string {
  let out = message;
  for (const pattern of QUOTED_SPANS) out = out.replace(pattern, "?");
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, "?");
  return collapse(out);
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
