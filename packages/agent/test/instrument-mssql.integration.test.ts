import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { patchMssql, patchTedious } from "../src/instrument/mssql.ts";

/**
 * `tedious` and `mssql` against a real SQL Server (ADR 0245): what the server of `support/mssql.ts` cannot answer —
 * prepared statements, a stored procedure, the errors a server builds, a transaction of `mssql`'s.
 *
 * Needs a server, and skips without one, as the real-MySQL tests do. A disposable one (Azure SQL Edge runs natively on
 * arm64; `mcr.microsoft.com/mssql/server:2022-latest` elsewhere):
 *
 *     docker run -d --name dt-mssql -e ACCEPT_EULA=1 -e MSSQL_SA_PASSWORD='Dt-zq-Passw0rd!' -p 127.0.0.1:31433:1433 \
 *       mcr.microsoft.com/azure-sql-edge:latest
 *     MSSQL_URL='mssql://sa:Dt-zq-Passw0rd!@127.0.0.1:31433' pnpm --filter @downtrace/agent exec vitest run instrument-mssql.integration
 */
const MSSQL_URL = process.env.MSSQL_URL;

if (!MSSQL_URL) {
  console.warn("[agent] MSSQL_URL not set: skipping the real SQL Server tests");
}

const handed: unknown[] = [];
const deps = { log: { warn: () => {}, debug: () => {} }, internalError: (err: unknown) => void handed.push(err) };
const require = createRequire(import.meta.url);

describe.skipIf(!MSSQL_URL)("tedious and mssql against a real SQL Server", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the driver's own types are not what these tests are about
  let sql: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  let pool: any;
  let target = "";

  beforeAll(async () => {
    const url = new URL(MSSQL_URL ?? "");
    const tedious = require("tedious");
    sql = require("mssql");
    const fingerprints = new FingerprintCache(1000, "mssql");
    patchTedious(tedious, "real", { ...deps, fingerprints, errors: new ErrorFingerprintCache() });
    patchMssql(sql, deps);
    target = `${url.hostname}:${url.port}`;
    pool = await new sql.ConnectionPool({
      server: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    // Set up outside any request, so none of it is counted.
    await pool.request().batch("IF OBJECT_ID('dt_users') IS NOT NULL DROP TABLE dt_users");
    await pool.request().batch("CREATE TABLE dt_users (id INT PRIMARY KEY, email NVARCHAR(100) UNIQUE)");
    await pool.request().batch("INSERT INTO dt_users (id, email) VALUES (1, 'ana@cliente.com')");
    await pool.request().batch("CREATE OR ALTER PROCEDURE dt_user_count AS SELECT COUNT(*) AS n FROM dt_users");
  });

  afterAll(async () => {
    await pool?.request().batch("IF OBJECT_ID('dt_users') IS NOT NULL DROP TABLE dt_users");
    await pool?.request().batch("DROP PROCEDURE IF EXISTS dt_user_count");
    await pool?.close();
    expect(handed, "the instrumentation failed while recording").toEqual([]);
  });

  const work = (ctx: RequestContext) => ctx.work?.get(dependencyKey("mssql", target));
  const texts = (ctx: RequestContext) =>
    [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => [o.text, o.count, o.errors]);

  it("counts a parameterised query, the text as T-SQL reads it", async () => {
    const ctx = enterRequest();
    const result = await pool.request().input("id", sql.Int, 1).query("SELECT email FROM dt_users WHERE id = @id");
    expect(result.recordset[0]?.email).toBe("ana@cliente.com");
    expect(work(ctx)).toMatchObject({ calls: 1, errors: 0 });
    expect(texts(ctx)).toEqual([["SELECT email FROM dt_users WHERE id = ?", 1, 0]]);
  });

  it("counts a prepared statement each time it runs, and its preparation", async () => {
    const statement = new sql.PreparedStatement(pool);
    statement.input("id", sql.Int);
    await statement.prepare("SELECT email FROM dt_users WHERE id = @id");
    const ctx = enterRequest();
    await statement.execute({ id: 1 });
    await statement.execute({ id: 2 });
    await statement.unprepare();
    expect(texts(ctx).find(([text]) => text === "SELECT email FROM dt_users WHERE id = ?")?.[1]).toBe(2);
  });

  it("counts a stored procedure by its name", async () => {
    const ctx = enterRequest();
    const result = await pool.request().execute("dt_user_count");
    expect(result.recordset[0]?.n).toBe(1);
    expect(texts(ctx)).toEqual([["dt_user_count", 1, 0]]);
  });

  it("counts the error the server answered, with a signature that carries no value", async () => {
    const ctx = enterRequest();
    const failure = await pool
      .request()
      .input("email", sql.NVarChar, "ana@cliente.com")
      .query("INSERT INTO dt_users (id, email) VALUES (2, @email)")
      .catch((e: unknown) => e);
    expect((failure as { number?: unknown }).number).toBe(2627);
    expect(work(ctx)).toMatchObject({ calls: 1, errors: 1 });
    const signatures = [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "error");
    expect(signatures).toHaveLength(1);
    expect(JSON.stringify(signatures)).not.toContain("ana@cliente.com");
  });

  it("counts the statements of a transaction, and its begin and commit as calls", async () => {
    const ctx = enterRequest();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    await new sql.Request(transaction)
      .input("id", sql.Int, 1)
      .query("UPDATE dt_users SET email = email WHERE id = @id");
    await transaction.commit();
    expect(texts(ctx)).toEqual([["UPDATE dt_users SET email = email WHERE id = ?", 1, 0]]);
    expect(work(ctx)?.calls).toBe(3);
  });
});
