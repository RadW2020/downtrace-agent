import type * as Mysql2 from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache, fingerprintOf } from "../src/fingerprint.ts";
import { patchMysql } from "../src/instrument/mysql.ts";
import { freshMysql2 } from "./support/mysql.ts";

/**
 * `mysql2` against a MySQL server (DT-91): what a server of this process cannot answer, because it does not
 * prepare statements and it does not read SQL — prepared statements, and the lexer that decides what a quote is.
 *
 * Needs a server, and skips without one, as the integration tests of the other packages do without
 * `DATABASE_URL` (gh-143). A disposable one:
 *
 *     docker run -d --name dt-mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=dt -p 127.0.0.1:33306:3306 mysql:8.4
 *     MYSQL_URL=mysql://root:pw@127.0.0.1:33306/dt pnpm --filter @downtrace/agent exec vitest run instrument-mysql.integration
 *
 * CI has no MySQL service, so it is not run there: the tests beside it run the real driver against a server in
 * the process, and this one is what keeps that server honest.
 */
const MYSQL_URL = process.env.MYSQL_URL;
/** For the types: nothing below runs without it. */
const URI = MYSQL_URL ?? "";

if (!MYSQL_URL) {
  console.warn(
    "[agent] MYSQL_URL not set: skipping the real-MySQL tests (docker run -p 127.0.0.1:33306:3306 mysql:8.4, then MYSQL_URL=mysql://root:pw@127.0.0.1:33306/dt)",
  );
}

const handed: unknown[] = [];
const deps = { log: { warn: () => {}, debug: () => {} }, internalError: (err: unknown) => void handed.push(err) };

describe.skipIf(!MYSQL_URL)("mysql2 against a real MySQL", () => {
  let mysql: typeof Mysql2;
  let pool: Mysql2.Pool;
  let target = "";

  beforeAll(async () => {
    mysql = freshMysql2();
    patchMysql(mysql, "real", {
      ...deps,
      fingerprints: new FingerprintCache(1000, "mysql"),
      errors: new ErrorFingerprintCache(),
    });
    pool = mysql.createPool({ uri: URI, connectionLimit: 2 });
    const config = (pool as unknown as { config: { connectionConfig: { host: string; port: number } } }).config;
    target = `${config.connectionConfig.host}:${config.connectionConfig.port}`;
    // Set up outside any request, so none of it is counted.
    const db = pool.promise();
    await db.query("DROP TABLE IF EXISTS dt_users");
    await db.query(
      "CREATE TABLE dt_users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100) UNIQUE, name VARCHAR(50))",
    );
    await db.query("INSERT INTO dt_users (email, name) VALUES ('ana@cliente.com', 'ana')");
  });

  afterAll(async () => {
    await pool.promise().query("DROP TABLE IF EXISTS dt_users");
    await new Promise<void>((resolve) => pool.end(() => resolve()));
    expect(handed, "the instrumentation failed while recording").toEqual([]);
  });

  /** A connection of its own, for what changes the session's `sql_mode`: a pooled one would carry it to the next test. */
  const alone = () => mysql.createConnection({ uri: URI }).promise();
  const work = (ctx: RequestContext) => ctx.work?.get(dependencyKey("mysql", target));
  const texts = (ctx: RequestContext) =>
    [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => o.text);

  it("counts a prepared statement run with `execute`, in the callback form and in the promise form", async () => {
    const ctx = enterRequest();
    await new Promise<void>((resolve, reject) =>
      pool.execute("SELECT ? AS n, name FROM dt_users WHERE email = ?", [1, "ana@cliente.com"], (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    const [rows] = await pool.promise().execute("SELECT id FROM dt_users WHERE email = ?", ["ana@cliente.com"]);
    expect(rows).toHaveLength(1);
    expect(texts(ctx).sort()).toEqual([
      "SELECT ? AS n, name FROM dt_users WHERE email = ?",
      "SELECT id FROM dt_users WHERE email = ?",
    ]);
    expect(work(ctx)).toMatchObject({ kind: "mysql", target, calls: 2, errors: 0 });
    expect(JSON.stringify([...(ctx.operations ?? [])])).not.toContain("ana@cliente.com");
  });

  it("counts a prepared statement that the server refuses, and a query that it does", async () => {
    const ctx = enterRequest();
    await expect(pool.promise().execute("SELEC 1 FROM", [])).rejects.toMatchObject({ code: "ER_PARSE_ERROR" });
    await expect(
      pool.promise().query("INSERT INTO dt_users (email, name) VALUES (?, ?)", ["ana@cliente.com", "x"]),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    expect(work(ctx)).toMatchObject({ calls: 2, errors: 2 });
    const wire = JSON.stringify([...(ctx.operations ?? [])]);
    expect(wire, "the value in the server's own error message").not.toContain("ana@cliente.com");
    expect(wire).toContain("Duplicate entry");
  });

  it("waits for a connection of a pool that has none free, apart from the query", async () => {
    const small = mysql.createPool({ uri: URI, connectionLimit: 1 });
    try {
      const holder = enterRequest();
      const first = small.promise().query("SELECT SLEEP(0.3)");
      const waiter = enterRequest();
      const second = small.promise().query("SELECT 1");
      await Promise.all([first, second]);
      const waited = waiter.work?.get(dependencyKey("mysql", target));
      expect(waited?.waitMs).toBeGreaterThanOrEqual(200);
      expect(waited?.ms).toBeLessThan(waited?.waitMs ?? 0);
      expect(holder.work?.get(dependencyKey("mysql", target))?.calls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => small.end(() => resolve()));
    }
  });

  /**
   * The premise of the dialect, asked of the server that decides it: each of these is a value to MySQL, with
   * the default `sql_mode`, and so each must be a `?` in the label. A value the server read as a string and the
   * scanner kept would be invariant 5 broken in the one place it can be.
   */
  describe("what the server reads as a value, the scanner does not keep", () => {
    const forms: Array<[form: string, value: string]> = [
      [`'zq-secret'`, "zq-secret"],
      [`"zq-secret"`, "zq-secret"],
      [`'it''s zq-secret'`, "it's zq-secret"],
      [`"say ""zq-secret"""`, `say "zq-secret"`],
      [`'it\\'s zq-secret'`, "it's zq-secret"],
      [`"say \\"zq-secret\\""`, `say "zq-secret"`],
      [`'a' 'zq-secret'`, "azq-secret"],
      [`_utf8mb4'zq-secret'`, "zq-secret"],
      [`N'zq-secret'`, "zq-secret"],
      [`X'7A712D736563726574'`, "zq-secret"],
      [`0x7A712D736563726574`, "zq-secret"],
    ];

    it.each(forms)("%s", async (form, value) => {
      const [rows] = await pool.promise().query(`SELECT ${form} AS v`);
      const got = String((rows as Array<{ v: unknown }>)[0]?.v);
      expect(got, "the server read it as the value the case says").toBe(value);
      const fingerprint = fingerprintOf(`SELECT ${form} AS v`, "mysql");
      expect(fingerprint.text, form).not.toContain("secret");
      expect(fingerprint.text, form).not.toContain("zq");
    });

    it("reads a comment as the server does: a hash, a dash before a blank, a block", async () => {
      for (const sql of ["SELECT 1 AS v # zq-secret", "SELECT 1 AS v -- zq-secret", "SELECT /* zq-secret */ 1 AS v"]) {
        const [rows] = await pool.promise().query(sql);
        expect(String((rows as Array<{ v: unknown }>)[0]?.v), sql).toBe("1");
        const fingerprint = fingerprintOf(sql, "mysql");
        expect(fingerprint.text, sql).toBe("SELECT ? AS v");
        expect(fingerprint.class).toBeUndefined();
      }
    });

    it("does not trust what the server reads in a way the scanner does not", async () => {
      // `5--3` is `5 - -3` to the server: eight. The scanner cannot tell it from a comment, and says so.
      const [rows] = await pool.promise().query("SELECT 5--3 AS v");
      expect(String((rows as Array<{ v: unknown }>)[0]?.v)).toBe("8");
      expect(fingerprintOf("SELECT 5--3 AS v", "mysql").class).toBe("select");
      // With `NO_BACKSLASH_ESCAPES` a backslash is a character, and `'x\\'` is a whole string: the case in which the
      // scanner's default reading and the server's part, and the scanner does not understand the text.
      const connection = alone();
      try {
        await connection.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')");
        const [plain] = await connection.query("SELECT 'x\\' AS v, 'zq-secret' AS w");
        expect((plain as Array<{ v: string; w: string }>)[0]).toEqual({ v: "x\\", w: "zq-secret" });
        const fingerprint = fingerprintOf("SELECT 'x\\' AS v, 'zq-secret' AS w", "mysql");
        expect(fingerprint.class).toBe("select");
        expect(fingerprint.text).toBe("");
      } finally {
        await connection.end();
      }
    });

    it("reads a double-quoted name as a value, which is what it is until `ANSI_QUOTES` says otherwise", async () => {
      const connection = alone();
      try {
        const [asValue] = await connection.query(`SELECT "name" AS v FROM dt_users`);
        expect((asValue as Array<{ v: string }>)[0]?.v, "a string").toBe("name");
        await connection.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')");
        const [asName] = await connection.query(`SELECT "name" AS v FROM dt_users`);
        expect((asName as Array<{ v: string }>)[0]?.v, "the column").toBe("ana");
        // The label is poorer for a server in that mode, and nothing leaves: the scanner cannot know the mode.
        expect(fingerprintOf(`SELECT "name" AS v FROM dt_users`, "mysql").text).toBe("SELECT ? AS v FROM dt_users");
      } finally {
        await connection.end();
      }
    });
  });
});
