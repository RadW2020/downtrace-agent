import { describe, expect, it } from "vitest";
import {
  classOf,
  DIALECTS,
  type Dialect,
  FingerprintCache,
  fingerprintOf,
  normalizeQuery,
} from "../src/fingerprint.ts";

/**
 * The normaliser reads the SQL of the database the query is for (DT-91).
 *
 * ADR 0086 left it written down: the scanner's background assumption was Postgres, where a double quote
 * always delimits an identifier, and «en MySQL sin `ANSI_QUOTES` delimita una cadena, y entonces conservar su
 * contenido sería otro fallo… si algún día se instrumenta MySQL, hay que volver aquí». This is the coming back.
 * Everything below asks the same thing of the MySQL reading that `fingerprint.test.ts` asks of the Postgres one
 * (invariant 5), and the cases that decide it are enumerated from the dialect's own table of rules — a delimiter
 * added to it is checked without anybody remembering to write its case (ADR 0086's lesson, twice).
 */

const mysql = (sql: string) => fingerprintOf(sql, "mysql");
const understood = (sql: string) => mysql(sql).class === undefined;

/** Fails when `secret` survives in the text the query would travel with. */
const leaks = (sql: string, secret: string, dialect: Dialect = "mysql") => {
  const { text } = fingerprintOf(sql, dialect);
  expect(text, `leaked from: ${sql}`).not.toContain(secret);
};

describe("a double quote in MySQL is a value", () => {
  it("replaces it with a placeholder and keeps the backticked identifiers", () => {
    expect(normalizeQuery(`SELECT * FROM users WHERE name = "ana"`, "mysql")).toBe(
      "SELECT * FROM users WHERE name = ?",
    );
    expect(normalizeQuery("SELECT `name` FROM `users`", "mysql")).toBe("SELECT `name` FROM `users`");
    expect(understood(`SELECT * FROM users WHERE name = "ana"`)).toBe(true);
    expect(understood("SELECT `name` FROM `users`")).toBe(true);
  });

  it("is the trap ADR 0086 names: read as Postgres, the same text would travel with the value in it", () => {
    // The reason the dialect is a parameter and not a detail. If this stopped being true the test below would
    // prove nothing about the MySQL reading, so it is pinned: Postgres keeps `"ana"` because there it is a name.
    expect(normalizeQuery(`SELECT * FROM users WHERE name = "ana-secret"`, "postgres")).toContain("ana-secret");
    leaks(`SELECT * FROM users WHERE name = "ana-secret"`, "ana-secret", "mysql");
  });

  it("does not read a backtick as Postgres reads it: not at all", () => {
    expect(fingerprintOf("SELECT `name` FROM `users`", "postgres").class).toBe("select");
    expect(fingerprintOf("SELECT `name` FROM `users`").class, "Postgres is still the default").toBe("select");
  });

  it("gives two queries that differ only in their quoted values the same identity", () => {
    const a = mysql(`SELECT * FROM users WHERE name = "ana" AND city = 'Madrid'`);
    const b = mysql(`SELECT * FROM users WHERE name = 'luis' AND city = "Lima"`);
    expect(a.text).toBe("SELECT * FROM users WHERE name = ? AND city = ?");
    expect(a.hash).toBe(b.hash);
  });

  it("collapses a list of values whichever quote wrote them", () => {
    const three = mysql(`SELECT * FROM t WHERE c IN ("a", 'b', 3)`);
    const one = mysql("SELECT * FROM t WHERE c IN (?)");
    expect(three.text).toBe("SELECT * FROM t WHERE c IN (?)");
    expect(three.hash).toBe(one.hash);
  });
});

// ADR 0086: «la prueba no es una lista». The rules are data, so the cases are read from the data.
describe.each(Object.keys(DIALECTS) as Dialect[])("every quote the %s dialect declares", (dialect) => {
  const rules = DIALECTS[dialect];
  const quotes = Object.entries(rules.quotes);
  const of = (sql: string) => fingerprintOf(sql, dialect);

  it("is not an empty table", () => {
    expect(quotes.length).toBeGreaterThan(0);
  });

  it.each(quotes)("%s: what it opens, closed, doubled or escaped, is read as the dialect reads it", (open, quote) => {
    if (quote.opens === "string") {
      // A value: it goes whatever is inside, and doubling the delimiter puts one inside without closing.
      expect(of(`SELECT ${open}zq-secret${open}`).text).toBe("SELECT ?");
      expect(of(`SELECT ${open}a${open}${open}zq-secret${open}`).text).toBe("SELECT ?");
      expect(of(`SELECT ${open}zq-secret${open} FROM t WHERE a = 1`).text).toBe("SELECT ? FROM t WHERE a = ?");
    } else {
      // A name: it stays, with its delimiters, and a doubled delimiter is a character of the name.
      expect(of(`SELECT ${open}Order Items${open}`).text).toBe(`SELECT ${open}Order Items${open}`);
      expect(of(`SELECT ${open}a${open}${open}b${open}`).text).toBe(`SELECT ${open}a${open}${open}b${open}`);
      // And it is only a name while nothing in it is a value (gh-350).
      expect(of(`SELECT * FROM ${open}user ana@cliente.com 4821${open}`).text).not.toContain("ana@cliente.com");
      expect(of(`SELECT * FROM ${open}user ana@cliente.com 4821${open}`).text).not.toContain("4821");
    }
    expect(of(`SELECT ${open}Order Items${open}`).class, "a closed one is understood").toBeUndefined();

    // A backslash takes the delimiter with it only where the dialect says it does.
    const escaped = of(`SELECT ${open}a\\${open}zq-secret${open}`);
    if (quote.backslash) {
      expect(escaped.class, "the escaped delimiter did not close it").toBeUndefined();
      expect(escaped.text).toBe(quote.opens === "string" ? "SELECT ?" : `SELECT ${open}a\\${open}zq-secret${open}`);
    } else {
      // It closed at the delimiter after the backslash, and what follows is read as syntax, which here is a
      // name and a minus and a name; the third delimiter then opens another and nothing closes it.
      expect(escaped.class, "the third delimiter never closes").toBeDefined();
      expect(escaped.text).toBe("");
    }
  });

  it.each(quotes)("%s: one that opens and never closes is not understood, and says nothing of what it took", (open) => {
    for (const sql of [
      `SELECT ${open}zq-secret`,
      `SELECT * FROM t WHERE a = ${open}zq-secret AND b = 'zq-secret-two'`,
      `SELECT * FROM ${open}zq-secret WHERE email = ${open === "'" ? '"' : "'"}ana@cliente.com${open === "'" ? '"' : "'"}`,
    ]) {
      const { text, class: kind } = of(sql);
      expect(text, `labelled: ${sql}`).toBe("");
      expect(kind, `no class for: ${sql}`).toBe("select");
      expect(text).not.toContain("zq-secret");
    }
  });
});

describe("the other rules MySQL has and Postgres does not", () => {
  it("drops a hash comment, which in Postgres is an operator and a word", () => {
    expect(normalizeQuery("SELECT 1 # token=secret-value", "mysql")).toBe("SELECT ?");
    expect(understood("SELECT 1 # token=secret-value")).toBe(true);
    expect(normalizeQuery("SELECT 1 # token=secret-value\nFROM t", "mysql")).toBe("SELECT ? FROM t");
    // The contrast: the same text read as Postgres puts the comment on the wire.
    expect(normalizeQuery("SELECT 1 # token=secret-value", "postgres")).toContain("secret");
  });

  it("opens a dash comment only before a blank, and does not trust one that is not", () => {
    expect(normalizeQuery("SELECT 1 -- token=secret-value", "mysql")).toBe("SELECT ?");
    expect(normalizeQuery("SELECT 1 --\tsecret-value\nFROM t", "mysql")).toBe("SELECT ? FROM t");
    // The end of the text and a control character count as a blank, as they do for the server.
    expect(normalizeQuery("SELECT 1 --", "mysql")).toBe("SELECT ?");
    expect(normalizeQuery("SELECT 1 --\u0001secret-value", "mysql")).toBe("SELECT ?");
    // `--x` is `- -x` to MySQL and a comment to a person; the scanner reads neither with confidence.
    for (const sql of ["SELECT 1 --token=secret-value", "SELECT 5--3"]) {
      expect(understood(sql), sql).toBe(false);
      leaks(sql, "secret-value");
    }
    expect(mysql("SELECT 5--3").class).toBe("select");
  });

  it("does not understand a version-conditional comment, because the server runs what is inside it", () => {
    // `/*!40001 … */` is SQL to MySQL (and `/*M!…*/` to MariaDB): its content is read as code, strings and all,
    // and the first `*/` may be inside one of them. Dropped as a comment it would be right; read as a comment
    // when the server does not, it would not.
    for (const sql of [
      "SELECT /*!40001 SQL_NO_CACHE */ * FROM t",
      "SELECT /*M!100100 SQL_NO_CACHE */ * FROM t",
      "SELECT /*!50000 '*/' */ * FROM t WHERE a = 'zq-secret'",
    ]) {
      const { text, class: kind } = mysql(sql);
      expect(text, sql).toBe("");
      expect(kind, sql).toBe("select");
    }
    leaks("SELECT /*!50000 '*/' */ * FROM t WHERE a = 'zq-secret'", "zq-secret");
  });

  it("drops an optimizer hint, which is a comment to everything but the optimizer", () => {
    expect(normalizeQuery("SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t", "mysql")).toBe("SELECT * FROM t");
  });

  it("does not nest block comments, and does not trust a text that tries to", () => {
    // MySQL ends a comment at the first `*/`, and its manual adds that under some conditions it does not: a
    // second opening inside one is a doubt, and a doubt is omitted (product.md, «omission when in doubt»).
    expect(normalizeQuery("SELECT /* a */ 1", "mysql")).toBe("SELECT ?");
    const nested = "SELECT /* a /* zq-secret */ b */ 1";
    expect(understood(nested)).toBe(false);
    leaks(nested, "zq-secret");
    // Postgres nests them, and its reading of the same text is still the nested one.
    expect(normalizeQuery(nested, "postgres")).toBe("SELECT ?");
  });

  it("takes a dollar sign for a character of a name, because MySQL has no dollar quoting", () => {
    expect(normalizeQuery("SELECT col$1 FROM t$x WHERE a = 1", "mysql")).toBe("SELECT col$1 FROM t$x WHERE a = ?");
    expect(understood("SELECT $a FROM t")).toBe(true);
    expect(fingerprintOf("SELECT col$1 FROM t$x", "postgres").class, "Postgres does not").toBe("select");
  });

  it("reads the prefix of a string as a name and the string as a value", () => {
    expect(normalizeQuery("SELECT _utf8mb4'zq-secret', N'zq-secret', X'7A71', x'7A71', b'0101', 0x7A71", "mysql")).toBe(
      "SELECT _utf8mb4?, N?, X?, x?, b?, ?",
    );
  });

  it("leaves the placeholders the driver substitutes, and the named ones", () => {
    expect(normalizeQuery("SELECT * FROM ?? WHERE id = ? AND n = :name", "mysql")).toBe(
      "SELECT * FROM ?? WHERE id = ? AND n = ?",
    );
    expect(normalizeQuery("INSERT INTO t (a, b) VALUES ?", "mysql")).toBe("INSERT INTO t (a, b) VALUES ?");
  });

  it("keeps a backticked identifier that carries a backtick of its own", () => {
    expect(normalizeQuery("SELECT `a``b` FROM t WHERE id = 1", "mysql")).toBe("SELECT `a``b` FROM t WHERE id = ?");
  });

  it("does not take a backslash for an escape inside backticks", () => {
    // Inside them a backslash is a character, and the backtick after it closes. Read as an escape it would
    // swallow the rest of the query, and the query would not be understood.
    const sql = "SELECT `a\\`, 'zq-secret' FROM t";
    expect(understood(sql)).toBe(true);
    leaks(sql, "zq-secret");
  });
});

// The server can read a backslash in a string in two ways (`NO_BACKSLASH_ESCAPES`), and the scanner cannot know
// which. Every text on which the two readings part ends either not understood or with the value out.
describe("a backslash before a quote", () => {
  it("is an escape, as in the default mode", () => {
    expect(normalizeQuery('SELECT \'it\\\'s zq-secret\', "say \\"zq-secret\\""', "mysql")).toBe("SELECT ?, ?");
  });

  it("does not let the two readings of it put a value on the wire", () => {
    const parting = [
      // Closed by the server under NO_BACKSLASH_ESCAPES, still open for the scanner, which then reads the
      // value between the quotes as a name — and meets a backslash outside any string.
      `SELECT * FROM t WHERE a = 'x\\' AND b = 'zq-secret' AND c = 'y\\'`,
      `SELECT * FROM t WHERE a = "x\\" AND b = "zq-secret" AND c = "y\\"`,
      `SELECT * FROM t WHERE a = 'x\\' AND b = 'zq-secret'`,
    ];
    for (const sql of parting) {
      leaks(sql, "zq-secret");
      expect(understood(sql), `trusted: ${sql}`).toBe(false);
    }
  });
});

// A value that tries to survive, in the MySQL spelling. Every one is delimited, so none may reach the text.
const HOSTILE =
  "SELECT `order id`, email FROM `orders` WHERE email = 'ana@cliente.com' AND name = \"ana-secret\"" +
  " AND token = x'73656372657431' AND id = 4821 /* trace=req-77ab */ # note=sk-live-9f1c\n" +
  "AND ref = 'a\\'zq-escaped' -- ticket=t-5521\nAND ok = 1";
const SECRETS = [
  "ana@cliente.com",
  "ana-secret",
  "73656372657431",
  "4821",
  "req-77ab",
  "sk-live-9f1c",
  "zq-escaped",
  "t-5521",
];

/**
 * What can be put into a query to change how the rest of it is read, taken from the dialect's rules and not
 * written down once more: its quotes, and each way it opens a comment.
 */
function openers(dialect: Dialect): string[] {
  const rules = DIALECTS[dialect];
  const found = Object.keys(rules.quotes);
  found.push("/*", "-- ", "\\");
  if (rules.hashComments) found.push("#");
  if (rules.executableComments) found.push("/*!");
  return found;
}

describe("MySQL text, against literals that try to survive", () => {
  it("is understood and clean as written", () => {
    const { text, class: kind } = mysql(HOSTILE);
    expect(kind).toBeUndefined();
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain("`order id`");
  });

  it("gives nothing away wherever any opener lands", () => {
    // The Postgres test puts one stray double quote at every position. A MySQL query has more ways to lose
    // the partner of a delimiter, and each is read from the rules: a quote of each kind, each way a comment
    // opens, a backslash. Put each at every position, and ask the same of all.
    for (const opener of openers("mysql")) {
      for (let at = 0; at <= HOSTILE.length; at++) {
        const broken = `${HOSTILE.slice(0, at)}${opener}${HOSTILE.slice(at)}`;
        for (const secret of SECRETS) leaks(broken, secret);
      }
    }
  });

  it("gives nothing away at any point the query can be cut", () => {
    for (let end = 0; end <= HOSTILE.length; end++) {
      for (const secret of SECRETS) leaks(HOSTILE.slice(0, end), secret);
    }
  });

  it("never answers with a label and a class at once, wherever it is broken", () => {
    let classified = 0;
    for (const opener of openers("mysql")) {
      for (let at = 0; at <= HOSTILE.length; at++) {
        const { text, class: kind } = mysql(`${HOSTILE.slice(0, at)}${opener}${HOSTILE.slice(at)}`);
        if (kind !== undefined) {
          expect(text).toBe("");
          classified++;
        }
      }
    }
    expect(classified).toBeGreaterThan(HOSTILE.length);
  });

  it("truncates without leaving half a literal behind", () => {
    const { text } = mysql(`SELECT ${"x".repeat(2000)} FROM t WHERE a = "secret"`);
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).not.toContain("secret");
  });
});

describe("classOf, in MySQL", () => {
  it("reads past a hash comment and a dash comment, where an ORM puts its tag", () => {
    expect(classOf("# app:web\nSELECT 1", "mysql")).toBe("select");
    expect(classOf("-- app:web\nUPDATE t SET a = 1", "mysql")).toBe("update");
    expect(classOf("/* app:web */ DELETE FROM t", "mysql")).toBe("delete");
  });

  it("says `other` rather than guess at a dash that is not a comment", () => {
    expect(classOf("--x\nSELECT 1", "mysql")).toBe("other");
    // In Postgres a hash is not a comment, and the word after it is not the first.
    expect(classOf("# app:web\nSELECT 1", "postgres")).toBe("other");
    expect(classOf("# app:web\nSELECT 1")).toBe("other");
  });
});

describe("the cache of MySQL texts", () => {
  it("normalises as the dialect it was made for", () => {
    const cache = new FingerprintCache(16, "mysql");
    expect(cache.dialect).toBe("mysql");
    expect(cache.get(`SELECT * FROM users WHERE name = "ana-secret"`).text).toBe("SELECT * FROM users WHERE name = ?");
    expect(new FingerprintCache(16).dialect, "and Postgres when nobody says").toBe("postgres");
  });

  it("carries the class of a text it did not understand, once", () => {
    const cache = new FingerprintCache(16, "mysql");
    const cut = "SELECT * FROM `orders WHERE email = 'ana@cliente.com'";
    for (let i = 0; i < 100; i++) cache.get(cut);
    expect(cache.misses).toBe(1);
    expect(cache.get(cut)).toMatchObject({ text: "", class: "select" });
  });

  it("keeps the hash of a Postgres query exactly where it was", () => {
    // Pinned to the values of the day `fingerprint.test.ts` pinned them: reading MySQL changed nothing here.
    expect(fingerprintOf("SELECT id FROM products WHERE id = 42").hash).toBe("69ae55bc440f9b1a");
    expect(fingerprintOf("SELECT id FROM products WHERE id = 42", "postgres").hash).toBe("69ae55bc440f9b1a");
  });
});
