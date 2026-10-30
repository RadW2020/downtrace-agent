import { describe, expect, it } from "vitest";
import { classOf, FingerprintCache, fingerprintOf, normalizeQuery } from "../src/fingerprint.ts";

/**
 * SQLite's reading (ADR 0239). The cases every dialect shares — each quote it declares, closed, doubled, escaped and
 * left open — are enumerated from `DIALECTS` in `fingerprint-mysql.test.ts`; these are the rules SQLite has of its own.
 */

const sqlite = (sql: string) => fingerprintOf(sql, "sqlite");
const understood = (sql: string) => sqlite(sql).class === undefined;

/** Fails when `secret` survives in the text the query would travel with. */
const leaks = (sql: string, secret: string) => {
  expect(sqlite(sql).text, `leaked from: ${sql}`).not.toContain(secret);
};

describe("a name in SQLite", () => {
  it("is kept between double quotes, backticks and brackets, as the ORMs write it", () => {
    // Drizzle, Prisma, Knex and Sequelize all write `"name"`; `[name]` and `` `name` `` are SQLite's compatibility.
    for (const sql of [
      `select "id", "email" from "users" where "id" = ?`,
      "select `id`, `email` from `users` where `id` = ?",
      "select [id], [email] from [users] where [id] = ?",
      `select [Order Items].[unit price] from [Order Items]`,
    ]) {
      expect(normalizeQuery(sql, "sqlite")).toBe(sql);
      expect(understood(sql)).toBe(true);
    }
  });

  it("is sanitised inside brackets as inside quotes, and an email or a number in one does not travel", () => {
    leaks("SELECT * FROM [user ana@cliente.com 4821]", "ana@cliente.com");
    leaks("SELECT * FROM [user ana@cliente.com 4821]", "4821");
    expect(normalizeQuery("SELECT * FROM [tenant_8f3a9c2e1b7d4f60]", "sqlite")).toBe("SELECT * FROM ?");
  });

  it("does not close a bracket where a doubled closer would only be a character", () => {
    // SQLite has no escape inside brackets; reading `]]` as one keeps the name longer and never shorter.
    expect(normalizeQuery("SELECT [a]]b] FROM t", "sqlite")).toBe("SELECT [a]]b] FROM t");
  });

  it("is not understood when a bracket closes what nothing opened", () => {
    // A `]` outside a bracket is no SQL SQLite runs, so what is around it is not what the scanner thinks it reads.
    const stray = sqlite("SELECT a] FROM t WHERE email = zq-secret");
    expect(stray.class).toBe("select");
    expect(stray.text).toBe("");
  });

  it("reads a double-quoted value written by hand as a name, sanitised as one", () => {
    // SQLite takes `"x"` for a string when no column is called x (its «double-quoted string literal» misfeature),
    // and better-sqlite3 is built without it. As a name, what looks like a value inside still goes.
    leaks(`SELECT * FROM users WHERE email = "ana@cliente.com"`, "ana@cliente.com");
    // Shaped like a Stripe key, so assembled here: the mirror's push protection refuses one written whole (ADR 0155).
    const token = ["sk", "live", "9f1c2d3e4a5b6c7d"].join("_");
    leaks(`SELECT * FROM users WHERE token = "${token}"`, token);
  });
});

describe("a value in SQLite", () => {
  it("is a single-quoted string, a blob, a number or a placeholder", () => {
    expect(normalizeQuery("SELECT * FROM t WHERE a = 'ana' AND b = x'0A1B' AND c = 42 AND d = 1.5e3", "sqlite")).toBe(
      "SELECT * FROM t WHERE a = ? AND b = x? AND c = ? AND d = ?",
    );
    expect(normalizeQuery("SELECT * FROM t WHERE a = :email AND b = ?", "sqlite")).toBe(
      "SELECT * FROM t WHERE a = ? AND b = ?",
    );
  });

  it("has no backslash escape: a backslash before a quote is a character, and the quote closes", () => {
    expect(normalizeQuery(String.raw`SELECT 'C:\' AS path, name FROM t`, "sqlite")).toBe(
      "SELECT ? AS path, name FROM t",
    );
    expect(understood(String.raw`SELECT 'C:\' AS path FROM t`)).toBe(true);
    // Read as MySQL, the same text swallows the rest of the query.
    expect(fingerprintOf(String.raw`SELECT 'C:\' AS path FROM t`, "mysql").class).toBe("select");
  });

  it("collapses lists and rows as every dialect does", () => {
    const many = sqlite("insert into t (a, b) values (1, 'x'), (2, 'y'), (3, 'z')");
    expect(many.text).toBe("insert into t (a, b) values (?)");
    expect(many.hash).toBe(sqlite("insert into t (a, b) values (?, ?)").hash);
  });
});

describe("a comment in SQLite", () => {
  it("is dropped, dash or block, and a hash is not one", () => {
    expect(normalizeQuery("SELECT 1 -- token=secret-value\nFROM t", "sqlite")).toBe("SELECT ? FROM t");
    expect(normalizeQuery("/* app:web secret-value */ SELECT 1", "sqlite")).toBe("SELECT ?");
    expect(understood("SELECT 1 # secret-value")).toBe(true);
    expect(classOf("-- app:web\nUPDATE t SET a = 1", "sqlite")).toBe("update");
  });
});

describe("the cache of SQLite texts", () => {
  it("normalises as the dialect it was made for", () => {
    const cache = new FingerprintCache(16, "sqlite");
    expect(cache.dialect).toBe("sqlite");
    expect(cache.get("SELECT [email] FROM users WHERE id = 7").text).toBe("SELECT [email] FROM users WHERE id = ?");
  });
});

// A value that tries to survive, in the SQLite spelling. Every one is delimited, so none may reach the text.
const HOSTILE =
  `SELECT [order id], "email" FROM "orders" WHERE email = 'ana@cliente.com' AND name = 'ana-secret'` +
  " AND token = x'73656372657431' AND id = 4821 /* trace=req-77ab */ AND path = 'C:\\zq-path\\'" +
  " -- ticket=t-5521\nAND ok = 1";
const SECRETS = ["ana@cliente.com", "ana-secret", "73656372657431", "4821", "req-77ab", "zq-path", "t-5521"];

describe("SQLite text, against literals that try to survive", () => {
  // What can be put into a query to change how the rest of it is read: each quote and each closer of its own, each
  // way a comment opens, and a backslash, which SQLite does not read as an escape.
  const openers = ["'", '"', "`", "[", "]", "/*", "-- ", "\\"];

  it("is understood and clean as written", () => {
    const { text, class: kind } = sqlite(HOSTILE);
    expect(kind).toBeUndefined();
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain("[order id]");
  });

  it("gives nothing away wherever any opener lands", () => {
    for (const opener of openers) {
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
});
