import { describe, expect, it } from "vitest";
import { FingerprintCache, fingerprintOf, normalizeQuery } from "../src/fingerprint.ts";

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
  /** Every value here is delimited: a literal, a dollar-quoted body, a number, a comment. None may survive. */
  const HOSTILE =
    `SELECT "order id", email FROM "orders" WHERE email = 'ana@cliente.com'` +
    ` AND token = $tag$sk-live-9f1c$tag$ AND id = 4821 /* trace=req-77ab */`;
  const SECRETS = ["ana@cliente.com", "sk-live-9f1c", "4821", "req-77ab"];

  const leaks = (sql: string, secret: string) => {
    const { text } = fingerprintOf(sql);
    expect(text, `leaked from: ${sql}`).not.toContain(secret);
  };

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

  it("caches on the text as written, so the same shape written twice is two entries", () => {
    const cache = new FingerprintCache(16);
    const a = cache.get("SELECT id FROM t WHERE id = 1");
    const b = cache.get("SELECT id FROM t WHERE id = 2");
    expect(cache.size).toBe(2);
    expect(a.hash).toBe(b.hash);
  });
});
