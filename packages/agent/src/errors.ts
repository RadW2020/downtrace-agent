import { type Fingerprint, hash64 } from "./fingerprint.ts";

/**
 * Turns a thrown thing into what it *is*, without what it was *about*.
 *
 * `product.md:77` asks for three things — «tipo, mensaje saneado, firma del stack» — and the instrumentation
 * only ever counted errors. Counting says how many; this says which, which is the difference between «this
 * route started failing» and «this route started throwing **this**» (gh-338).
 *
 * The shape is the one a query already has, which the ADR 0017 left ready: «queries and error signatures
 * share one shape, so the next kind needs no new field». One rule for both — the text carries what a person
 * reads and the hash is of the text.
 *
 * This is the likeliest place in the whole product for a customer's data to appear: an error message is
 * where an identifier, an email or a token ends up. So the sanitising here is stricter than a query's
 * (invariant 5).
 */

/** Longer than this and the signature is truncated. Values are already gone by then. */
const MAX_TEXT = 512;

/**
 * How much of a sanitised message has to still be words for it to be worth sending.
 *
 * `product.md:113`: «cuando algo no puede procesarse con garantías, **se omite en lugar de arriesgarse**: […]
 * un mensaje de error que no encaja en los formatos conocidos viaja solo como tipo y firma, sin texto».
 *
 * There is no catalogue of «known formats» to check against, and there does not need to be one: the signal is
 * how much sense survives the sanitising. A message that comes out mostly `?` tells a reader nothing and only
 * risks whatever the patterns did not catch. Half is generous **towards omitting**, which is the criterion the
 * product states (gh-343).
 */
const MIN_MEANING = 0.5;
/** How many frames of the stack make the signature. Enough to tell two call sites apart, few enough to read. */
const FRAMES = 3;

/**
 * Anything that looks like a value. Order matters: the wider patterns run first so a UUID is not eaten as
 * three separate hex runs.
 *
 * Deliberately eager. A false positive costs a `?` where a word would have read better; a false negative
 * puts a customer's identifier in a batch, and there is no taking that back.
 */
const VALUE_PATTERNS: RegExp[] = [
  // Quoted spans, single or double, including an unterminated one — the same reasoning as the SQL scanner:
  // a pattern that requires the closing quote lets a malformed string through whole.
  /'[^']*'?/g,
  /"[^"]*"?/g,
  // Emails before anything splits them.
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // UUIDs, then any long hex or base64-ish run: tokens, hashes, ids.
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\b[0-9a-zA-Z_-]{16,}\b/g,
  // Anything with a digit in it. A word that carries a number is a value or a version, and neither belongs
  // in an identity.
  /\b\w*\d[\w.]*\b/g,
];

/** Replaces everything that looks like a value with `?`, and collapses the whitespace that is left. */
export function sanitizeMessage(message: string): string {
  let out = message;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, "?");
  // A run of values separated by nothing but punctuation is one value as far as identity goes: «expected 1,
  // 2, 3» and «expected 4, 5» are the same error, and leaving three question marks would make them two.
  return out
    .replace(/\?(\s*[,;:]?\s*\?)+/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One frame, reduced to what identifies the place and nothing about the machine.
 *
 * The file name and the line stay: they are the structure of the user's own code, like a route template, and
 * they are what makes a signature readable. The directory goes — it gives away the `$HOME` of whoever built
 * it and the path it was deployed to, and says nothing about the error.
 */
function frameOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return undefined;
  const body = trimmed.slice(3);
  // `at fn (/abs/path/file.js:12:5)` or `at /abs/path/file.js:12:5`
  const open = body.lastIndexOf("(");
  const fn = open > 0 ? body.slice(0, open).trim() : "";
  const where = open > 0 ? body.slice(open + 1).replace(/\)$/, "") : body;

  // Node's own frames and dependencies are collapsed: which line of `pg` threw is not this application's
  // shape, and keeping them would make every signature mostly library.
  if (where.startsWith("node:")) return fn ? `${fn} (node)` : "(node)";
  const dep = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(where);
  if (dep) return `(${dep[1]})`;

  const at = /([^\\/]+):(\d+):\d+$/.exec(where);
  const place = at ? `${at[1]}:${at[2]}` : "";
  if (!place) return fn || undefined;
  return fn ? `${fn}@${place}` : place;
}

/** The top frames, joined. Empty when there is no usable stack, which is a real case and not an error. */
export function stackSignature(stack: string | undefined): string {
  if (!stack) return "";
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const frame = frameOf(line);
    if (!frame) continue;
    frames.push(frame);
    if (frames.length === FRAMES) break;
  }
  return frames.join(" ← ");
}

/** The type of a thrown thing, for the many that are not `Error`. */
function typeOf(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor?.name || "Error";
  if (err === null) return "null";
  if (Array.isArray(err)) return "Array";
  if (typeof err === "object") return err.constructor?.name || "Object";
  return typeof err;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean" || err === null || err === undefined) {
    return String(err);
  }
  // An object thrown on purpose. Its own `message` if it has one, and nothing invented if it does not:
  // stringifying an arbitrary object is the shortest path to shipping whatever it holds.
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

/**
 * The signature of a thrown thing: type, sanitised message and where it came from.
 *
 * Everything a person needs to recognise it, and nothing a person could not have written themselves. Two
 * occurrences of the same error at the same place share a hash; the same message thrown somewhere else does
 * not, which is what makes the signature about the code and not about the sentence.
 */
export function errorFingerprint(err: unknown): Fingerprint {
  const type = typeOf(err);
  const sanitised = sanitizeMessage(messageOf(err));
  const message = meaningful(sanitised) ? sanitised : "";
  const where = stackSignature(err instanceof Error ? err.stack : undefined);
  let text = type;
  if (message !== "") {
    text = `${type}: ${message}`;
  } else if (sanitised !== "") {
    // Omitted rather than sent, and said out loud: a text that is missing without a reason is the kind of
    // silence this product does not practise (invariant 14).
    text = `${type}: (message omitted: nothing recognisable survived sanitising)`;
  }
  if (where !== "") text = `${text} · ${where}`;
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 1)}…`;
  return { text, hash: hash64(text) };
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

/** How many distinct errors one process is expected to throw. Beyond this the cache stops growing. */
export const DEFAULT_ERROR_CACHE_SIZE = 200;

/**
 * Signs each distinct error once.
 *
 * Keyed on the type and the raw stack rather than on the message, because the message is the part that
 * varies — «user 4821 not found» is a thousand strings and one error. The same reasoning as the query cache,
 * with the opposite key: there, the text as written is what repeats.
 *
 * When it fills it stops admitting rather than evicting, exactly like the query cache: an application
 * throwing unbounded distinct errors is the one that would thrash an LRU, and the answer stays correct.
 */
export class ErrorFingerprintCache {
  private readonly entries = new Map<string, Fingerprint>();
  private readonly max: number;
  misses = 0;

  constructor(max = DEFAULT_ERROR_CACHE_SIZE) {
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  get(err: unknown): Fingerprint {
    const key = err instanceof Error ? `${err.name}\n${err.stack ?? ""}\n${err.message}` : String(err);
    const cached = this.entries.get(key);
    if (cached) return cached;
    this.misses += 1;
    const fingerprint = errorFingerprint(err);
    if (this.entries.size < this.max) this.entries.set(key, fingerprint);
    return fingerprint;
  }
}
