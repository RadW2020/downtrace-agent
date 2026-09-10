import { describe, expect, it } from "vitest";
import { classOf, FingerprintCache, fingerprintOf, normalizeQuery } from "../src/fingerprint.ts";

/** Every value here is delimited: a literal, a dollar-quoted body, a number, a comment. None may survive. */
const HOSTILE =
  `SELECT "order id", email FROM "orders" WHERE email = 'ana@cliente.com'` +
  ` AND token = $tag$sk-live-9f1c$tag$ AND id = 4821 /* trace=req-77ab */`;
const SECRETS = ["ana@cliente.com", "sk-live-9f1c", "4821", "req-77ab"];

const leaks = (sql: string, secret: string) => {
  const { text } = fingerprintOf(sql);
  expect(text, `leaked from: ${sql}`).not.toContain(secret);
};

describe("normalizeQuery", () => {
  it("keeps the shape and drops the values", () => {
    expect(normalizeQuery("SELECT id FROM products WHERE id = 42")).toBe("SELECT id FROM products WHERE id = ?");
  });

  it("gives two queries that differ only in their values the same fingerprint", () => {
    const a = fingerprintOf("SELECT * FROM orders WHERE customer_id = 7 AND total > 19.99");
    const b = fingerprintOf("SELECT * FROM orders WHERE customer_id = 8109 AND total > 0.01");
    expect(a.text).toBe(b.text);
    expect(a.hash).toBe(b.hash);
  });

  it("does not care how long a list of values is", () => {
    const three = fingerprintOf("SELECT * FROM items WHERE id IN (1, 2, 3)");
    const one = fingerprintOf("SELECT * FROM items WHERE id IN (7)");
    const many = fingerprintOf("SELECT * FROM items WHERE id IN (1,2,3,4,5,6,7,8,9,10)");
    expect(three.hash).toBe(one.hash);
    expect(many.hash).toBe(one.hash);
  });

  it("collapses a multi-row insert to one row", () => {
    const two = fingerprintOf("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y')");
    const one = fingerprintOf("INSERT INTO t (a, b) VALUES (9, 'z')");
    expect(two.hash).toBe(one.hash);
  });

  it("leaves the placeholders an application already wrote", () => {
    expect(normalizeQuery("SELECT id FROM products WHERE id = $1 AND sku = $2")).toBe(
      "SELECT id FROM products WHERE id = ? AND sku = ?",
    );
    expect(normalizeQuery("SELECT id FROM t WHERE a = :name")).toBe("SELECT id FROM t WHERE a = ?");
  });

  it("does not lowercase, because a table is called what it is called", () => {
    expect(normalizeQuery('SELECT * FROM "OrderItems" WHERE id = 1')).toBe('SELECT * FROM "OrderItems" WHERE id = ?');
  });

  it("sanitises what a quoted identifier carries, because a name can be interpolated too", () => {
    // gh-350. Invariant 5 allows structural metadata out, and asks for it **sanitised**. A quoted identifier
    // is structure — the same family as a route template — but `SELECT * FROM "${schema}"` is a name built
    // from somebody's data, and with a doubled quote a whole literal fits inside one.
    leaks(`SELECT * FROM "user ana@cliente.com 4821"`, "ana@cliente.com");
    leaks(`SELECT * FROM "user ana@cliente.com 4821"`, "4821");
    const smuggled = `SELECT * FROM "a"" email = 'ana@cliente.com' AND id = 4821 "`;
    leaks(smuggled, "ana@cliente.com");
    leaks(smuggled, "4821");
  });

  it("drops the name entirely when nothing of it was a name", () => {
    // `"? ?"` is not a label, it is punctuation pretending to be one. Same threshold as an error message:
    // fewer than half the words surviving means it goes (ADR 0084).
    expect(normalizeQuery(`SELECT * FROM "4821 9f1c2d3e5a7b"`)).toBe("SELECT * FROM ?");
  });

  it("leaves a name that is only a name exactly as it is", () => {
    expect(normalizeQuery(`SELECT * FROM "order id"`)).toBe(`SELECT * FROM "order id"`);
    const before = fingerprintOf('SELECT * FROM "OrderItems" WHERE id = 1');
    expect(before.text).toBe(`SELECT * FROM "OrderItems" WHERE id = ?`);
    // The hash of the day this was written: sanitising a name that has no values in it must change nothing.
    expect(before.hash).toBe(fingerprintOf(`SELECT * FROM "OrderItems" WHERE id = 2`).hash);
  });

  it("keeps an identifier that carries a quote of its own", () => {
    // `"a""b"` is one name spelled with a doubled quote. The fix for the unterminated case must not eat it.
    expect(normalizeQuery('SELECT "a""b" FROM t WHERE id = 1')).toBe('SELECT "a""b" FROM t WHERE id = ?');
  });

  it("counts a doubled quote as part of the name and not as its end", () => {
    // Without this the pairing is simply first-to-second, and `"a""b` reads as the finished name `"a"` with a
    // stray quote after it, rather than as a name that opened and never closed. The label differs; so does
    // what the next test asks of it.
    expect(normalizeQuery('SELECT "a""b FROM t')).toBe("SELECT ?");
  });

  it("does not mistake digits inside an identifier for a value", () => {
    expect(normalizeQuery("SELECT col2 FROM table1 WHERE col2 = 5")).toBe("SELECT col2 FROM table1 WHERE col2 = ?");
  });

  it("collapses whitespace so formatting is not an identity", () => {
    const spread = fingerprintOf("SELECT id\n  FROM   products\n WHERE id = 1");
    const flat = fingerprintOf("SELECT id FROM products WHERE id = 2");
    expect(spread.hash).toBe(flat.hash);
  });
});

// Invariant 5: no query literal leaves the user's server. These are the hostile cases, not the polite ones.
describe("normalizeQuery, against literals that try to survive", () => {
  it("drops a literal with a doubled quote inside it", () => {
    leaks("SELECT * FROM users WHERE name = 'O''Brien-secret'", "Brien");
  });

  it("drops a literal with a backslash before the quote", () => {
    leaks("SELECT * FROM users WHERE name = 'a\\'sneaky'", "sneaky");
  });

  it("drops a literal that looks like SQL", () => {
    leaks("SELECT * FROM t WHERE a = 'password = hunter2'", "hunter2");
  });

  it("drops a literal that is never closed", () => {
    // An unterminated quote is the case a regex misses: it must swallow to the end, not give up and pass through.
    leaks("SELECT * FROM t WHERE a = 'tail-secret", "secret");
  });

  it("drops a dollar-quoted body, tagged or not", () => {
    leaks("SELECT $$body-secret$$", "secret");
    leaks("SELECT $tag$body-secret$tag$ FROM t", "secret");
    leaks("SELECT $tag$never-closed-secret", "secret");
  });

  it("drops what a comment carries", () => {
    leaks("SELECT 1 -- token=secret-value", "secret");
    leaks("SELECT /* token=secret-value */ 1", "secret");
    leaks("SELECT /* never closed secret", "secret");
  });

  it("drops a literal hiding behind a comment that is not one", () => {
    leaks("SELECT * FROM t WHERE a = '-- not a comment secret'", "secret");
  });

  it("treats a bare literal in the select list as the value it is", () => {
    expect(normalizeQuery("SELECT 1")).toBe("SELECT ?");
  });

  it("keeps nothing of a query that is only a literal", () => {
    expect(normalizeQuery("'just-a-secret'")).toBe("?");
  });

  it("drops what follows an identifier quote that never closes", () => {
    // gh-348. A double-quoted identifier is a name and stays, but only while it is one: with no closing quote
    // the scanner is no longer reading a name, it is reading the rest of the query, values and all.
    const cut = `SELECT * FROM "orders WHERE email = 'ana@cliente.com' AND id = 4821`;
    leaks(cut, "ana@cliente.com");
    leaks(cut, "4821");
  });

  it("gives nothing away wherever a stray double quote lands", () => {
    // The cases above are a list, and a list is written by hand: the unterminated double quote was not on it
    // until it leaked. So this one is not a list. An odd number of double quotes is what the bug looks like
    // however it arises — a name built by concatenation, a quote inside an identifier, a string cut in half —
    // so put one more at every position of a query whose values are all delimited, and ask the same of all.
    for (let at = 0; at <= HOSTILE.length; at++) {
      const broken = `${HOSTILE.slice(0, at)}"${HOSTILE.slice(at)}`;
      for (const secret of SECRETS) leaks(broken, secret);
    }
  });

  it("gives nothing away at any point a query can be cut", () => {
    // Truncation is the other way a delimiter loses its partner. It is sound to demand this of every prefix:
    // cutting at the end can leave a delimiter open, never turn a delimited value into bare syntax.
    for (let end = 0; end <= HOSTILE.length; end++) {
      for (const secret of SECRETS) leaks(HOSTILE.slice(0, end), secret);
    }
  });

  it("truncates without leaving half a literal behind", () => {
    const long = `SELECT ${"x".repeat(2000)} FROM t WHERE a = 'secret'`;
    const { text } = fingerprintOf(long);
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).not.toContain("secret");
  });
});

// `product.md:104`: «cuando algo no puede procesarse con garantías, se omite en lugar de arriesgarse: una
// consulta que el normalizador no entiende viaja solo como hash y clase» (gh-347).
describe("a query the scanner does not understand", () => {
  const understood = (sql: string) => fingerprintOf(sql).class === undefined;

  it("says so instead of labelling it, and keeps the identity", () => {
    const cut = `SELECT * FROM "orders WHERE email = 'ana@cliente.com'`;
    const { text, hash, class: kind } = fingerprintOf(cut);
    expect(text).toBe("");
    expect(kind).toBe("select");
    // The hash is a digest of the normalised text, which reveals nothing and keeps the cloud's grouping whole.
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf(cut).hash).toBe(hash);
  });

  it("does not understand a delimiter that opened and never closed", () => {
    expect(understood("SELECT * FROM t WHERE a = 'never closed")).toBe(false);
    expect(understood("SELECT $tag$never closed")).toBe(false);
    expect(understood("SELECT /* never closed")).toBe(false);
    expect(understood('SELECT * FROM "never closed')).toBe(false);
  });

  it("does understand a line comment that ends where the string ends", () => {
    // `--` has no closing delimiter to miss: running out of string is how it normally finishes.
    expect(understood("SELECT id FROM t -- por el ticket 42")).toBe(true);
    expect(understood("SELECT id FROM t -- por el ticket 42\nWHERE id = 1")).toBe(true);
  });

  it("does not understand a character it has no rule for", () => {
    // A backtick is MySQL and this scanner reads Postgres; a backslash is a psql meta-command. Either way the
    // text in front of the scanner is not the text it thinks it is reading.
    expect(understood("SELECT * FROM `users`")).toBe(false);
    expect(understood("\\copy t FROM 'f.csv'")).toBe(false);
    expect(understood("SELECT id FROM t WHERE a = 1 \u0000 AND b = 2")).toBe(false);
  });

  it("understands the ordinary punctuation of SQL, accents and all", () => {
    expect(understood("SELECT a::text, b->>'k' FROM t WHERE (a, b) <> (1, 2) AND c >= 3;")).toBe(true);
    expect(understood("SELECT año FROM señores WHERE número = 1")).toBe(true);
  });

  it("still normalises a query it does understand, down to the same hash as before", () => {
    // Pinned to the values of the day this was written, not to what the code now produces: the point of the
    // rule is that nothing changed for a query that was already fine.
    const a = fingerprintOf("SELECT id FROM products WHERE id = 42");
    expect(a.text).toBe("SELECT id FROM products WHERE id = ?");
    expect(a.hash).toBe("69ae55bc440f9b1a");
    expect(a.class).toBeUndefined();
    const b = fingerprintOf("INSERT INTO t (a) VALUES ('x')");
    expect(b.text).toBe("INSERT INTO t (a) VALUES (?)");
    expect(b.hash).toBe("0515d10a30a1c7c8");
  });

  // gh-368. The third kind of doubt: not «a delimiter that never closed» nor «a character with no rule», but
  // a construction the scanner **believes** it understood. No signal fires, the query is taken as read and
  // its text travels. These are the ones found by walking PostgreSQL's grammar rather than the code.
  it("reads a dollar-quote tag the way Postgres does, letters and all", () => {
    // Postgres takes as a tag what it takes as an identifier, and that includes non-ASCII letters. The
    // scanner already knows this everywhere else: `startsName` uses `\p{L}` so that `año` is a column.
    leaks("SELECT $étiquette$confidential_customer_name$étiquette$", "confidential_customer_name");
    expect(normalizeQuery("SELECT $étiquette$confidential$étiquette$")).toBe("SELECT ?");
  });

  it("does not understand a dollar sign it cannot account for", () => {
    // `a-b` and `1x` are not valid tags, so this is not valid SQL either. That is not a reason to emit it.
    for (const sql of ["SELECT $a-b$secreto$a-b$", "SELECT $1x$secreto$1x$", "SELECT a $ b"]) {
      const { text, class: kind } = fingerprintOf(sql);
      expect(text, `still labelled: ${sql}`).toBe("");
      expect(kind, `no class for: ${sql}`).toBeDefined();
    }
    leaks("SELECT $a-b$secreto$a-b$", "secreto");
    leaks("SELECT $1x$secreto$1x$", "secreto");
  });

  it("counts the depth of a block comment, because in Postgres they nest", () => {
    // `/* a /* b */ c */` is one comment and ends at the second `*/`. Stopping at the first emits the rest
    // of the comment verbatim, and a comment carries whatever anybody put in it.
    expect(normalizeQuery("SELECT /* a /* secreto */ b */ 1")).toBe("SELECT ?");
    leaks("SELECT /* nota /* interna */ token=secreto */ 1", "secreto");
    leaks("SELECT /* nota /* interna */ token=secreto */ 1", "token");
  });

  it("does not understand a nested comment that never closes at its level", () => {
    const { text, class: kind } = fingerprintOf("SELECT /* a /* secreto */ 1");
    expect(text).toBe("");
    expect(kind).toBeDefined();
  });

  it("never answers with a label and a class at once, wherever the corpus is broken", () => {
    // Not every insertion makes a malformed query: a `"` that lands inside a literal or a comment is part of
    // the value, and that query is as understood as it was. What must hold everywhere is that the two answers
    // are exclusive — a class is the reason there is no text — and that no value survives either way.
    let classified = 0;
    for (let at = 0; at <= HOSTILE.length; at++) {
      const broken = `${HOSTILE.slice(0, at)}"${HOSTILE.slice(at)}`;
      const { text, class: kind } = fingerprintOf(broken);
      if (kind !== undefined) {
        expect(text, `both a class and a label: ${broken}`).toBe("");
        classified++;
      }
      for (const secret of SECRETS) expect(text, `leaked from: ${broken}`).not.toContain(secret);
    }
    // The quote lands outside a literal far more often than inside one, and every one of those is malformed.
    expect(classified).toBeGreaterThan(HOSTILE.length / 2);
  });
});

describe("classOf", () => {
  it("is the first keyword, and nothing else", () => {
    expect(classOf("SELECT 1")).toBe("select");
    expect(classOf("  \n insert into t values (1)")).toBe("insert");
    expect(classOf("UPDATE t SET a = 1")).toBe("update");
    expect(classOf("DELETE FROM t")).toBe("delete");
  });

  it("reads past a leading comment, which is where an ORM puts its tag", () => {
    expect(classOf("/* app:web */ SELECT 1")).toBe("select");
    expect(classOf("-- cacheable\nSELECT 1")).toBe("select");
  });

  it("says `other` rather than guess", () => {
    // `WITH` usually ends in a SELECT, and «usually» is not something to say about a query already declared
    // not understood.
    expect(classOf("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("other");
    expect(classOf("BEGIN")).toBe("other");
    expect(classOf("")).toBe("other");
    expect(classOf("'just-a-secret'")).toBe("other");
  });

  it("can only ever answer one of five words", () => {
    // Nothing of the query can become the class: that is what makes it safe to send when the text is not.
    const answers = new Set<string>();
    for (const sql of [HOSTILE, "SELECT 1", "no soy sql", "ana@cliente.com", "`x`", ""]) answers.add(classOf(sql));
    for (const a of answers) expect(["select", "insert", "update", "delete", "other"]).toContain(a);
  });
});

describe("fingerprintOf", () => {
  it("gives a short, stable hash", () => {
    const a = fingerprintOf("SELECT id FROM t");
    const b = fingerprintOf("SELECT id FROM t");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives different queries different hashes", () => {
    expect(fingerprintOf("SELECT a FROM t").hash).not.toBe(fingerprintOf("SELECT b FROM t").hash);
  });

  it("has an answer for an empty query", () => {
    expect(fingerprintOf("").text).toBe("");
    expect(fingerprintOf("   ").text).toBe("");
  });
});

describe("FingerprintCache", () => {
  it("normalises one text once, however many times it is executed", () => {
    const cache = new FingerprintCache(16);
    const first = cache.get("SELECT id FROM products WHERE id = 1");
    for (let i = 0; i < 1000; i++) cache.get("SELECT id FROM products WHERE id = 1");
    expect(cache.size).toBe(1);
    expect(cache.misses).toBe(1);
    expect(cache.get("SELECT id FROM products WHERE id = 1")).toBe(first);
  });

  it("still answers when it is full, without growing", () => {
    const cache = new FingerprintCache(2);
    cache.get("SELECT id FROM a");
    cache.get("SELECT id FROM b");
    const overflow = cache.get("SELECT id FROM c WHERE id = 3");
    expect(cache.size).toBe(2);
    expect(overflow.text).toBe("SELECT id FROM c WHERE id = ?");
    // The answer is right whether or not it was stored; only the cost differs.
    expect(cache.get("SELECT id FROM c WHERE id = 4").hash).toBe(overflow.hash);
  });

  it("carries the class of a query it did not understand, once for all its executions", () => {
    const cache = new FingerprintCache(16);
    const cut = `SELECT * FROM "orders WHERE email = 'ana@cliente.com'`;
    for (let i = 0; i < 1000; i++) cache.get(cut);
    expect(cache.misses).toBe(1);
    expect(cache.get(cut).class).toBe("select");
    expect(cache.get(cut).text).toBe("");
  });

  it("caches on the text as written, so the same shape written twice is two entries", () => {
    const cache = new FingerprintCache(16);
    const a = cache.get("SELECT id FROM t WHERE id = 1");
    const b = cache.get("SELECT id FROM t WHERE id = 2");
    expect(cache.size).toBe(2);
    expect(a.hash).toBe(b.hash);
  });
});
