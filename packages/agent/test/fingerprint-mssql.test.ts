import { describe, expect, it } from "vitest";
import { classOf, fingerprintOf, normalizeQuery } from "../src/fingerprint.ts";

/**
 * SQL Server's reading, T-SQL (ADR 0245). The cases every dialect shares — each quote it declares, closed, doubled,
 * escaped and left open — are enumerated from `DIALECTS` in `fingerprint-mysql.test.ts`; these are the rules T-SQL has
 * of its own.
 */

const mssql = (sql: string) => fingerprintOf(sql, "mssql");
const understood = (sql: string) => mssql(sql).class === undefined;

/** Fails when `secret` survives in the text the query would travel with. */
const leaks = (sql: string, secret: string) => {
  expect(mssql(sql).text, `leaked from: ${sql}`).not.toContain(secret);
};

describe("a name in T-SQL", () => {
  it("is kept between brackets and between double quotes, as the ORMs for SQL Server write it", () => {
    // Sequelize, Knex and Prisma write `[name]`; TypeORM writes `"name"`, which `tedious`'s session reads as a name.
    for (const sql of [
      `SELECT "User"."id" AS "User_id", "User"."email" AS "User_email" FROM "typeorm_users" "User" WHERE (("User"."id" = ?))`,
      "SELECT [id], [email] FROM [dbo].[users] WHERE [id] = ?",
      "SELECT [Order Items].[unit price] FROM [Order Items]",
      "INSERT INTO [users] ([email]) OUTPUT INSERTED.[id] VALUES (?)",
    ]) {
      expect(normalizeQuery(sql, "mssql")).toBe(sql);
      expect(understood(sql)).toBe(true);
    }
  });

  it("reads a parameter as a placeholder, however the ORM names it, and leaves the server's `@@` functions", () => {
    // TypeORM writes `@0`, Prisma `@P1`, mssql and Knex `@p0`, Sequelize its own names: one label for all.
    expect(normalizeQuery("SELECT [id] FROM [users] WHERE [id] = @0 AND [email] = @P1 AND x = @param_2", "mssql")).toBe(
      "SELECT [id] FROM [users] WHERE [id] = ? AND [email] = ? AND x = ?",
    );
    expect(normalizeQuery("INSERT INTO t (a) VALUES (@p0); SELECT @@ROWCOUNT AS n, @@IDENTITY", "mssql")).toBe(
      "INSERT INTO t (a) VALUES (?); SELECT @@ROWCOUNT AS n, @@IDENTITY",
    );
    // MySQL's `@name` is a user variable, and stays one.
    expect(normalizeQuery("SELECT @total", "mysql")).toBe("SELECT @total");
  });

  it("keeps a temporary table's `#`, which opens no comment in T-SQL", () => {
    expect(normalizeQuery("SELECT * FROM #orders JOIN ##totals ON 1 = 1", "mssql")).toBe(
      "SELECT * FROM #orders JOIN ##totals ON ? = ?",
    );
  });

  it("is sanitised inside brackets as inside quotes, and an email or a number in one does not travel", () => {
    leaks("SELECT * FROM [user ana@cliente.com 4821]", "ana@cliente.com");
    leaks("SELECT * FROM [user ana@cliente.com 4821]", "4821");
    expect(normalizeQuery("SELECT * FROM [tenant_8f3a9c2e1b7d4f60]", "mssql")).toBe("SELECT * FROM ?");
  });

  it("reads `]]` inside brackets as a bracket of the name, as SQL Server does", () => {
    expect(normalizeQuery("SELECT [a]]b] FROM t", "mssql")).toBe("SELECT [a]]b] FROM t");
  });
});

describe("a value in T-SQL", () => {
  it("is a single-quoted string, a Unicode one, a number, a binary or a money literal", () => {
    expect(
      normalizeQuery(
        "SELECT * FROM t WHERE a = 'ana' AND b = N'zq-secret' AND c = 42 AND d = 0x0A1B AND e = $5.00 AND f = 1.5e3",
        "mssql",
      ),
    ).toBe("SELECT * FROM t WHERE a = ? AND b = N? AND c = ? AND d = ? AND e = ?.? AND f = ?");
    leaks("SELECT * FROM t WHERE price = $4821.50", "4821");
  });

  it("reads a double-quoted text as a name, and what looks like a value in one still goes", () => {
    // A session with QUOTED_IDENTIFIER off would read it as a string; `tedious` turns it on as it logs in.
    leaks(`SELECT * FROM users WHERE email = "ana@cliente.com"`, "ana@cliente.com");
    leaks(`SELECT * FROM "tenant 4821"`, "4821");
    expect(normalizeQuery(`SELECT "id" FROM users`, "mssql")).toBe(`SELECT "id" FROM users`);
  });

  it("has no backslash escape: a backslash before a quote is a character, and the quote closes", () => {
    expect(normalizeQuery(String.raw`SELECT 'C:\' AS path, name FROM t`, "mssql")).toBe(
      "SELECT ? AS path, name FROM t",
    );
    expect(understood(String.raw`SELECT 'C:\' AS path FROM t`)).toBe(true);
  });

  it("collapses lists and rows as every dialect does", () => {
    expect(mssql("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y'), (3, 'z')").text).toBe(
      "INSERT INTO t (a, b) VALUES (?)",
    );
    expect(mssql("SELECT * FROM t WHERE id IN (@p0, @p1, @p2)").text).toBe("SELECT * FROM t WHERE id IN (?)");
  });
});

describe("a comment in T-SQL", () => {
  it("nests, and a text whose comments close is understood with none of them", () => {
    const sql = "SELECT id /* outer /* inner 'zq-secret' */ still outer */ FROM t -- ana@cliente.com";
    expect(understood(sql)).toBe(true);
    leaks(sql, "zq-secret");
    leaks(sql, "ana@cliente.com");
  });

  it("is not understood when a block comment never closes", () => {
    const open = mssql("SELECT id FROM t /* outer /* inner */ WHERE email = 'ana@cliente.com'");
    expect(open.text).toBe("");
    expect(open.class).toBe("select");
  });
});

describe("the class of a T-SQL statement", () => {
  it("is the protocol's five, whatever SQL Server's own keywords", () => {
    expect(classOf("SELECT TOP (10) * FROM t", "mssql")).toBe("select");
    expect(classOf("UPDATE t SET a = @p0 OUTPUT INSERTED.id", "mssql")).toBe("update");
    expect(classOf("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE", "mssql")).toBe("other");
    expect(classOf("EXEC dbo.refresh @tenant = 3", "mssql")).toBe("other");
  });
});

// A value that tries to survive, in T-SQL's spelling: in a string, a binary, a number, a comment, and a name built from
// data. As in Postgres's test, each looks like a value, which is what a name is sanitised by (ADR 0090).
const HOSTILE =
  "SELECT [order id], email FROM [dbo].[orders] WHERE email = 'ana@cliente.com' AND name = \"user zq4417 9931\"" +
  " AND token = 0x73656372657431 AND id = 4821 AND n = N'zq7731' AND price = $77.12" +
  " /* trace=req-77ab /* nested=sk-live-9f1c */ */ AND ref = 'a''zq8842' -- ticket=t-5521\nAND ok = @p0";
const SECRETS = [
  "ana@cliente.com",
  "zq4417",
  "9931",
  "73656372657431",
  "4821",
  "zq7731",
  "77",
  "req-77ab",
  "sk-live-9f1c",
  "zq8842",
  "t-5521",
];
/** What can be put into a T-SQL text to change how the rest of it is read: each quote, each comment, a parameter. */
const OPENERS = ["'", '"', "[", "]", "/*", "-- ", "@", "$", "\\"];

describe("T-SQL text, against literals that try to survive", () => {
  it("is understood and clean as written", () => {
    const { text, class: kind } = mssql(HOSTILE);
    expect(kind).toBeUndefined();
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain("[order id]");
  });

  it("gives nothing away wherever any opener lands", () => {
    for (const opener of OPENERS) {
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
