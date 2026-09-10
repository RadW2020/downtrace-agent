import { meaningful, sanitizeValues } from "./sanitize.ts";

/**
 * Turns a query into what it *is*, without what it was *about*.
 *
 * This is the exact point where a literal can escape the user's server (ADR 0017, invariant 5), so it is written
 * as a single pass over the characters rather than a chain of regular expressions. The difference matters for
 * malformed input: a regex for `'…'` simply fails to match an unterminated quote and lets the whole thing
 * through, whereas a scanner that has entered a literal and never finds its end swallows to the end of the
 * string. That holds for every delimiter here, the double quote of an identifier included: a delimiter that
 * opens and never closes swallows the rest and emits `?`, because from there on the scanner is not reading
 * what it thought it was reading. What is emitted verbatim is only what a rule recognised.
 *
 * What survives is structure: keywords, table and column names, the shape of the statement. Case is left alone —
 * the hash is computed on the normalised text, so it is already insensitive to formatting, and lowercasing would
 * only make a real table name harder to read.
 */

/** Longer than this and the label is truncated. Values are already gone by then, so a cut cannot expose one. */
const MAX_TEXT = 1024;

/** What a statement is, when that is all that can be said about it safely. The protocol's five and no more. */
export type QueryClass = "select" | "insert" | "update" | "delete" | "other";

export interface Fingerprint {
  /** Normalised text: the label a person reads. Empty when the scan did not understand the query. */
  text: string;
  /** Stable identity, 16 hex characters. What the cloud groups and compares by. */
  hash: string;
  /**
   * Set only when the query was not understood, and then it is the whole label. Its presence is the reason
   * the text is absent, which is how the cloud tells «omitted» from «suppressed» (ADR 0085).
   */
  class?: QueryClass;
}

const isIdentifierChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
/**
 * Where a bare name may start, and what may continue it. Not `[A-Za-z_]`: Postgres takes letters, and `año` is
 * a column somewhere. The ASCII case is answered with two comparisons and only the rest reaches the regex —
 * this runs per character of every distinct query, and the property escapes cost forty percent when it ran
 * for all of them.
 */
const LETTER = /\p{L}/u;
const startsName = (c: string): boolean => {
  const k = c.charCodeAt(0);
  if ((k >= 97 && k <= 122) || (k >= 65 && k <= 90) || k === 95) return true;
  return k > 127 && LETTER.test(c);
};
const insideName = (c: string): boolean => {
  const k = c.charCodeAt(0);
  if ((k >= 97 && k <= 122) || (k >= 65 && k <= 90) || (k >= 48 && k <= 57) || k === 95 || k === 36) return true;
  return k > 127 && LETTER.test(c);
};
/**
 * Everything else SQL is made of. A character that is not a name, a number, a delimiter or one of these is a
 * character this scanner has no rule for — a backtick (that is MySQL), a backslash (that is psql), a control
 * byte — and the honest conclusion is that the text in front of it is not the text it thinks it is reading.
 */
const PUNCTUATION = new Set("()[]{},;.:*=<>+-/%|&^~!?@#'\"`$".split("").filter((c) => c !== "`"));

/**
 * A closed identifier, with anything that looks like a value taken out of it.
 *
 * Invariant 5 lets structural metadata leave and asks for it **sanitised**, and a quoted identifier is
 * structure — the same family as a route template. But the name between the quotes is not always written by
 * whoever wrote the query: `SELECT * FROM "${schema}"` builds it from data, and a doubled quote is part of
 * the name in SQL, so `"a"" email = \'ana@cliente.com\' "` is one identifier carrying a whole literal.
 *
 * The same patterns that sanitise an error message, and the same threshold: a name of which fewer than half
 * the words survive is not a name any more, and goes out as `?` rather than as punctuation pretending to be
 * a label (ADR 0084). A name with no values in it comes back untouched, which is the ordinary case and the
 * reason the label is worth having at all (gh-350).
 */
function quotedName(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const sanitised = sanitizeValues(inner);
  if (sanitised === inner) return quoted;
  return meaningful(sanitised) ? `"${sanitised}"` : "?";
}

/** What one scan found: the label, and whether it believes it. */
interface Scan {
  text: string;
  understood: boolean;
}

export function normalizeQuery(sql: string): string {
  return scanQuery(sql).text;
}

function scanQuery(sql: string): Scan {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  /** The last character emitted, to tell `table1` from `= 1`. */
  let previous = "";
  /** A delimiter opened and the scan reached the end still inside it, so it swallowed it does not know what. */
  let swallowed = false;
  /** A character with no rule at all. One is enough: this is not a vote. */
  let unknown = false;

  const emit = (s: string): void => {
    out.push(s);
    previous = s.charAt(s.length - 1);
  };

  while (i < n) {
    const c = sql[i] as string;

    // A single-quoted literal. Doubled quotes and backslash escapes stay inside it; an unterminated one runs to
    // the end of the string, which is the whole point of scanning instead of matching.
    if (c === "'") {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) swallowed = true;
      emit("?");
      continue;
    }

    if (c === "$") {
      // `$1`: a placeholder the application already wrote.
      if (isDigit(sql[i + 1] ?? "")) {
        i++;
        while (i < n && isDigit(sql[i] as string)) i++;
        emit("?");
        continue;
      }
      // `$tag$…$tag$` or `$$…$$`: a dollar-quoted body, which is a value however it is spelled.
      const close = sql.indexOf("$", i + 1);
      const tag = close === -1 ? undefined : sql.slice(i + 1, close);
      if (tag !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$|^$/.test(tag)) {
        const delimiter = `$${tag}$`;
        const end = sql.indexOf(delimiter, close + 1);
        if (end === -1) swallowed = true;
        i = end === -1 ? n : end + delimiter.length;
        emit("?");
        continue;
      }
    }

    // A named placeholder, `:name`. `::` is a cast, not a parameter.
    if (c === ":" && sql[i + 1] !== ":" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      i += 2;
      while (i < n && isIdentifierChar(sql[i] as string)) i++;
      emit("?");
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      emit(" ");
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) swallowed = true;
      i = end === -1 ? n : end + 2;
      emit(" ");
      continue;
    }

    // A double-quoted identifier is a name, not a value: it is what makes the label readable, so it stays —
    // but only while it is one. With no closing quote the scanner is not reading a name any more, it is
    // reading whatever the rest of the query happens to be, literals included, and emitting it verbatim is
    // the very thing this file exists to prevent (gh-348). Unread is unread: it becomes `?`, as `'` does.
    if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        swallowed = true;
        emit("?");
        continue;
      }
      emit(quotedName(sql.slice(start, i)));
      continue;
    }

    // A bare name or keyword: `orders`, `SELECT`, `user_id`. Taking it whole rather than a letter at a time is
    // what lets the last rule below mean «a character I have no rule for» instead of «a letter in a name».
    if (startsName(c)) {
      const start = i;
      i++;
      while (i < n && insideName(sql[i] as string)) i++;
      emit(sql.slice(start, i));
      continue;
    }

    // A number, but only where a number can begin: `col2` is a name, `= 2` is a value.
    if (isDigit(c) && !isIdentifierChar(previous)) {
      i++;
      while (i < n && /[0-9a-fA-FxX._]/.test(sql[i] as string)) i++;
      if ((sql[i] === "e" || sql[i] === "E") && /[0-9+-]/.test(sql[i + 1] ?? "")) {
        i += 2;
        while (i < n && isDigit(sql[i] as string)) i++;
      }
      emit("?");
      continue;
    }

    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i++;
      if (previous !== "" && previous !== " ") emit(" ");
      continue;
    }

    if (!PUNCTUATION.has(c)) unknown = true;
    emit(c);
    i++;
  }

  const flat = out.join("").trim();
  // A list of values is not an identity: `IN (1, 2, 3)` and `IN (7)` are the same query asked twice.
  const listsCollapsed = flat.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)");
  // Same for a multi-row insert: the number of rows is a value too.
  const rowsCollapsed = listsCollapsed.replace(/\(\?\)(?:\s*,\s*\(\?\))+/g, "(?)");
  const text = rowsCollapsed.length > MAX_TEXT ? rowsCollapsed.slice(0, MAX_TEXT) : rowsCollapsed;
  return { text, understood: !swallowed && !unknown };
}

/**
 * 64 bits of FNV-1a as two independent 32-bit passes, because a single 32-bit hash collides too readily across
 * the thousands of fingerprints a large application produces, and BigInt in a per-query path is not worth it.
 */
/** Shared with the error signatures, which hash their own text the same way (`errors.ts`, gh-338). */
export function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * What kind of statement this is, for a query whose text cannot be sent.
 *
 * The first keyword, and one of five constants or nothing: no path here turns a piece of the query into the
 * answer, which is what makes this safe to send when the label is not. `WITH` is `other` on purpose — it
 * usually ends in a SELECT, and «usually» is not a thing to say about a query already declared not understood.
 */
export function classOf(sql: string): QueryClass {
  let i = 0;
  // An ORM writes its tag in a comment before the verb, so the verb is not always the first word.
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      if (end === -1) return "other";
      i = end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return "other";
      i = end + 2;
    } else {
      break;
    }
  }
  let end = i;
  while (end < sql.length && insideName(sql[end] as string)) end++;
  const word = sql.slice(i, end).toLowerCase();
  return word === "select" || word === "insert" || word === "update" || word === "delete" ? word : "other";
}

export function fingerprintOf(sql: string): Fingerprint {
  const { text, understood } = scanQuery(sql);
  // The hash is a digest of the normalised text either way: it reveals nothing, and keeping it means a query
  // that cannot be labelled is still one operation the cloud can group, count and compare (ADR 0017).
  const hash = hash64(text);
  return understood ? { text, hash } : { text: "", hash, class: classOf(sql) };
}

/** How many distinct query texts one process is expected to write. Beyond this the cache stops growing. */
export const DEFAULT_CACHE_SIZE = 1000;

/**
 * Normalises each distinct query text once.
 *
 * Applications write their queries as literals in the source or as prepared statements, so the same few hundred
 * strings arrive over and over: caching on the text as written turns the per-execution cost into one map lookup,
 * which is what keeps this affordable inside the request path (invariant 3).
 *
 * When it fills it stops admitting entries rather than evicting: an application generating unbounded query texts
 * is exactly the one that would thrash an LRU, and the answer stays correct either way — only the cost differs.
 */
export class FingerprintCache {
  private readonly entries = new Map<string, Fingerprint>();
  private readonly max: number;
  /** How many texts had to be normalised. Only interesting in tests and when debugging the cost. */
  misses = 0;

  constructor(max = DEFAULT_CACHE_SIZE) {
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  get(sql: string): Fingerprint {
    const cached = this.entries.get(sql);
    if (cached) return cached;
    this.misses += 1;
    const fingerprint = fingerprintOf(sql);
    if (this.entries.size < this.max) this.entries.set(sql, fingerprint);
    return fingerprint;
  }
}
