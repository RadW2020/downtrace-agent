import { type Fingerprint, hash64 } from "./fingerprint.ts";
import { meaningful, sanitizeMessage } from "./sanitize.ts";

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
/** How many frames of the stack make the signature. Enough to tell two call sites apart, few enough to read. */
const FRAMES = 3;

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

/** How many distinct errors one process is expected to throw. Beyond this the cache stops growing. */
export const DEFAULT_ERROR_CACHE_SIZE = 200;

/**
 * Signs each distinct error once.
 *
 * Keyed on exactly what the signature reads, and on nothing else. For an `Error` that is its name, its raw
 * stack and its message. For anything else it is the type and the message `errorFingerprint` will read —
 * **not** `String(err)`, which is `"[object Object]"` for every object thrown, so the second one came back
 * wearing the first one's signature and the first one's message (gh-368). That is not a coarse identity, it
 * is the wrong evidence.
 *
 * The message is part of the key because the signature is built from it. It is not the query cache's
 * reasoning inverted by accident: there the text as written is what repeats, and here two throws from the
 * same place with different numbers in the message do share a signature — the sanitising is what collapses
 * them, and it runs on a miss.
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
    const key =
      err instanceof Error
        ? `Error\n${err.name}\n${err.stack ?? ""}\n${err.message}`
        : `${typeOf(err)}\n${messageOf(err)}`;
    const cached = this.entries.get(key);
    if (cached) return cached;
    this.misses += 1;
    const fingerprint = errorFingerprint(err);
    if (this.entries.size < this.max) this.entries.set(key, fingerprint);
    return fingerprint;
  }
}
