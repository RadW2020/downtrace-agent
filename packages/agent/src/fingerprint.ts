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

export interface Fingerprint {
  /** Normalised text: the label a person reads. */
  text: string;
  /** Stable identity, 16 hex characters. What the cloud groups and compares by. */
  hash: string;
}

const isIdentifierChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

export function normalizeQuery(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  /** The last character emitted, to tell `table1` from `= 1`. */
  let previous = "";

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
          break;
        }
        i++;
      }
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
      emit(closed ? sql.slice(start, i) : "?");
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

    emit(c);
    i++;
  }

  const flat = out.join("").trim();
  // A list of values is not an identity: `IN (1, 2, 3)` and `IN (7)` are the same query asked twice.
  const listsCollapsed = flat.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)");
  // Same for a multi-row insert: the number of rows is a value too.
  const rowsCollapsed = listsCollapsed.replace(/\(\?\)(?:\s*,\s*\(\?\))+/g, "(?)");
  return rowsCollapsed.length > MAX_TEXT ? rowsCollapsed.slice(0, MAX_TEXT) : rowsCollapsed;
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

export function fingerprintOf(sql: string): Fingerprint {
  const text = normalizeQuery(sql);
  return { text, hash: hash64(text) };
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
