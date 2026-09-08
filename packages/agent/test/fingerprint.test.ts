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
