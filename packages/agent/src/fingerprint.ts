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
 * It reads the SQL of the database the query is for (`Dialect`, DT-91). The scanner started as Postgres' and
 * ADR 0086 wrote down what that assumed: a double quote is a name there and a value in MySQL, and keeping its
 * content would have been the same failure in another database. So what a quote opens, how a comment opens and
 * what a `$` is are data in `DIALECTS`, one table per dialect, and the scan consults it. A text is read as the
 * dialect of the driver that ran it and never as another, and Postgres is the default only for the callers
 * that were written before there was a second.
 *
 * What survives is structure: keywords, table and column names, the shape of the statement. Case is left alone —
 * the hash is computed on the normalised text, so it is already insensitive to formatting, and lowercasing would
 * only make a real table name harder to read.
 */

/** Longer than this and the label is truncated. Values are already gone by then, so a cut cannot expose one. */
const MAX_TEXT = 1024;

/**
 * The SQL a query is written in. A quote opens a name in one and a value in the other, a comment opens with a
 * different character, and the only way to read a text safely is to read it the way the server that will run it
 * does — which is the database the driver talks to, and not something the text says about itself (DT-91).
 */
export type Dialect = "postgres" | "mysql";

/** What a character that opens a quoted span is the start of. */
export interface Quote {
  /**
   * `string` is a value: it comes out as `?`, whatever is inside. `identifier` is a name: it stays, delimiters
   * and all, for as long as it is one — closed, and with nothing in it that looks like a value (gh-350).
   */
  opens: "string" | "identifier";
  /**
   * Whether a backslash takes the next character with it, so that `\'` does not close. Where the server reads
   * it both ways depending on a setting the text does not carry (`standard_conforming_strings` in Postgres,
   * `NO_BACKSLASH_ESCAPES` in MySQL), it is read as an escape: that swallows more and never less, and a span
   * that swallowed to the end is not understood (ADR 0028).
   */
  backslash: boolean;
}

/**
 * How one dialect quotes and comments. Data and not branches, so that a test can enumerate every delimiter a
 * dialect has and ask the same of each (ADR 0086: a list written by hand was missing the case that leaked).
 */
export interface DialectRules {
  /**
   * By the character that opens them. The closer is the same character; doubling it puts one inside.
   * A quote the table does not list is a character the scanner has no rule for.
   */
  quotes: Readonly<Record<string, Quote>>;
  /** `$tag$…$tag$` is a value (Postgres). Where it is not, a `$` is a character of a name (MySQL). */
  dollarQuoting: boolean;
  /** A block comment may hold another (Postgres), and ends at the second closing. Where it may not, a second opening is a doubt. */
  nestedComments: boolean;
  /** `#` opens a comment to the end of the line (MySQL). In Postgres it is an operator. */
  hashComments: boolean;
  /** `--` opens a comment only before a blank, a control character or the end of the text (MySQL). */
  dashCommentNeedsBlank: boolean;
  /**
   * A block comment opened with a bang, or with `M!` for MariaDB, is SQL the server runs and not a comment
   * (MySQL). What is inside is read as code, strings and all, so a text that has one is not understood.
   */
  executableComments: boolean;
}

export const DIALECTS: Readonly<Record<Dialect, DialectRules>> = {
  postgres: {
    quotes: {
      "'": { opens: "string", backslash: true },
      '"': { opens: "identifier", backslash: false },
    },
    dollarQuoting: true,
    nestedComments: true,
    hashComments: false,
    dashCommentNeedsBlank: false,
    executableComments: false,
  },
  mysql: {
    // Without `ANSI_QUOTES`, which is the server's default and not something the text says, a double quote
    // delimits a string, exactly as a single one does (ADR 0086). With it on, a double-quoted name is read as
    // a value and goes as `?`: the label is poorer and nothing leaves.
    quotes: {
      "'": { opens: "string", backslash: true },
      '"': { opens: "string", backslash: true },
      "`": { opens: "identifier", backslash: false },
    },
    dollarQuoting: false,
    nestedComments: false,
    hashComments: true,
    dashCommentNeedsBlank: true,
    executableComments: true,
  },
};

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
 * a column somewhere.
 *
 * A `$` does **not** continue a name here, although Postgres allows it in one. It is the character that opens
 * a dollar-quoted body, and a name that swallowed it hid `x$secreto$1x$` inside one identifier — the body
 * came out whole. Ending the name at the `$` hands it to the rule that knows what to do with it, which for
 * anything it cannot account for is to stop trusting the query (gh-368). The ASCII case is answered with two comparisons and only the rest reaches the regex —
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
  if ((k >= 97 && k <= 122) || (k >= 65 && k <= 90) || (k >= 48 && k <= 57) || k === 95) return true;
  return k > 127 && LETTER.test(c);
};
/**
 * The tag of a dollar-quoted body, read the way PostgreSQL reads it: **the same rules as an identifier**.
 * `$étiquette$` is a valid dollar quote, and a check that only accepted ASCII left its body to be emitted
 * word by word (gh-368). Empty is the `$$…$$` form.
 */
const isDollarTag = (tag: string): boolean => {
  if (tag === "") return true;
  if (!startsName(tag[0] as string)) return false;
  for (let k = 1; k < tag.length; k++) if (!insideName(tag[k] as string)) return false;
  return true;
};

/**
 * Everything else SQL is made of. A character that is not a name, a number, a delimiter or one of these is a
 * character this scanner has no rule for — a backtick where the dialect has no rule for one (it is MySQL's quote,
 * and in a Postgres text it is a sign the query is not Postgres'), a backslash (that is psql), a control byte —
 * and the honest conclusion is that the text in front of it is not the text it thinks it is reading.
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
function quotedName(quoted: string, delimiter: string): string {
  const inner = quoted.slice(1, -1);
  const sanitised = sanitizeValues(inner);
  if (sanitised === inner) return quoted;
  return meaningful(sanitised) ? `${delimiter}${sanitised}${delimiter}` : "?";
}

/**
 * What ends a dash comment in MySQL: `--` is a comment there only when a blank follows it, and the end of the
 * text and a control character count as one, as they do for the server (MySQL's reference, «Comment syntax»).
 */
function isBlank(c: string | undefined): boolean {
  if (c === undefined) return true;
  const k = c.charCodeAt(0);
  return k <= 32 || k === 127;
}

/** What one scan found: the label, and whether it believes it. */
interface Scan {
  text: string;
  understood: boolean;
}

export function normalizeQuery(sql: string, dialect: Dialect = "postgres"): string {
  return scanQuery(sql, dialect).text;
}

function scanQuery(sql: string, dialect: Dialect): Scan {
  const rules = DIALECTS[dialect];
  /** Where Postgres has dollar quoting a `$` opens a body; where it has none, it is a letter of a name. */
  const dollarIsName = !rules.dollarQuoting;
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

    // A quoted span: a literal, or an identifier, as the dialect says this character is the start of. Doubled
    // delimiters (and backslash escapes, where the dialect has them) stay inside it; one that is never closed
    // runs to the end of the string, which is the whole point of scanning instead of matching. An identifier
    // is a name and not a value and is the label's best part, so it stays — but only while it is one. With no
    // closing delimiter the scanner is not reading a name any more, it is reading whatever the rest of the
    // query happens to be, literals included, and emitting it verbatim is the very thing this file exists to
    // prevent (gh-348). Unread is unread: it becomes `?`, as an unclosed literal does, in every dialect.
    const quote = rules.quotes[c];
    if (quote !== undefined) {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (quote.backslash && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
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
      emit(quote.opens === "string" ? "?" : quotedName(sql.slice(start, i), c));
      continue;
    }

    if (c === "$" && rules.dollarQuoting) {
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
      if (tag !== undefined && isDollarTag(tag)) {
        const delimiter = `$${tag}$`;
        const end = sql.indexOf(delimiter, close + 1);
        if (end === -1) swallowed = true;
        i = end === -1 ? n : end + delimiter.length;
        emit("?");
        continue;
      }
      // A `$` that is neither of those. It may be a tag this scanner reads differently from Postgres, or
      // not a dollar-quote at all — and either way the next characters are not what they seem to be. Not
      // knowing what it was is enough to stop trusting the rest (gh-368).
      unknown = true;
    }

    // A named placeholder, `:name`. `::` is a cast, not a parameter.
    if (c === ":" && sql[i + 1] !== ":" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      i += 2;
      while (i < n && isIdentifierChar(sql[i] as string)) i++;
      emit("?");
      continue;
    }

    // A comment to the end of the line: `--` where the dialect has it, `#` where it has that. MySQL opens a
    // dash comment only before a blank; a `--` that does not is a minus and a minus to the server and a
    // comment to a person, and the scanner reads neither with confidence.
    if (c === "-" && sql[i + 1] === "-" && rules.dashCommentNeedsBlank && !isBlank(sql[i + 2])) {
      unknown = true;
    } else if ((c === "-" && sql[i + 1] === "-") || (c === "#" && rules.hashComments)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      if (previous !== "" && previous !== " ") emit(" ");
      continue;
    }

    // Block comments **nest** in PostgreSQL: `/* a /* b */ c */` is one comment and ends at the second
    // `*/`. Stopping at the first emits the rest of the comment as if it were SQL, and a comment carries
    // whatever anybody put in it — an ORM tag with the request's context, for instance (gh-368).
    //
    // MySQL does not nest them, and its manual adds that under some conditions it might: a second opening
    // inside a comment is a doubt, and a doubt is omitted. And a comment opened with a bang is not a comment
    // there but SQL the server runs, whose strings may hold the `*/` that ends this scan: it is not read.
    if (c === "/" && sql[i + 1] === "*") {
      if (rules.executableComments && (sql[i + 2] === "!" || (sql[i + 2] === "M" && sql[i + 3] === "!"))) {
        unknown = true;
      }
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          if (rules.nestedComments) depth++;
          else unknown = true;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      if (depth > 0) swallowed = true;
      // A comment is whitespace as far as the label goes, so it collapses like whitespace: emitting a space
      // unconditionally left `SELECT  ?` with two of them.
      if (previous !== "" && previous !== " ") emit(" ");
      continue;
    }

    // A bare name or keyword: `orders`, `SELECT`, `user_id`. Taking it whole rather than a letter at a time is
    // what lets the last rule below mean «a character I have no rule for» instead of «a letter in a name».
    if (startsName(c) || (dollarIsName && c === "$")) {
      const start = i;
      i++;
      while (i < n && (insideName(sql[i] as string) || (dollarIsName && sql[i] === "$"))) i++;
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
export function classOf(sql: string, dialect: Dialect = "postgres"): QueryClass {
  const rules = DIALECTS[dialect];
  let i = 0;
  // An ORM writes its tag in a comment before the verb, so the verb is not always the first word.
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i++;
    } else if (
      (c === "-" && sql[i + 1] === "-" && (!rules.dashCommentNeedsBlank || isBlank(sql[i + 2]))) ||
      (c === "#" && rules.hashComments)
    ) {
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

export function fingerprintOf(sql: string, dialect: Dialect = "postgres"): Fingerprint {
  const { text, understood } = scanQuery(sql, dialect);
  // The hash is a digest of the normalised text either way: it reveals nothing, and keeping it means a query
  // that cannot be labelled is still one operation the cloud can group, count and compare (ADR 0017).
  const hash = hash64(text);
  return understood ? { text, hash } : { text: "", hash, class: classOf(sql, dialect) };
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
  /**
   * The dialect every text in it is read as. A cache is for one database: the same text is two different
   * queries to two different servers, and a cache that mixed them would hand a MySQL query a Postgres label.
   */
  readonly dialect: Dialect;
  /** How many texts had to be normalised. Only interesting in tests and when debugging the cost. */
  misses = 0;

  constructor(max = DEFAULT_CACHE_SIZE, dialect: Dialect = "postgres") {
    this.max = max;
    this.dialect = dialect;
  }

  get size(): number {
    return this.entries.size;
  }

  get(sql: string): Fingerprint {
    const cached = this.entries.get(sql);
    if (cached) return cached;
    this.misses += 1;
    const fingerprint = fingerprintOf(sql, this.dialect);
    if (this.entries.size < this.max) this.entries.set(sql, fingerprint);
    return fingerprint;
  }
}
