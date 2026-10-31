import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { patchMariadbCallback, patchMariadbConnection, patchMariadbPool } from "../src/instrument/mariadb.ts";
import { loadMariadb, type Mariadb, type MariadbCopy } from "./support/mariadb.ts";

/**
 * `mariadb` against a real server: what the server of `support/mysql.ts` cannot answer — prepared statements
 * (`execute`), a batch, and the errors a server builds. MySQL and MariaDB both, because the driver speaks to each in
 * its own way: a batch is one bulk command to MariaDB, and one statement per row to MySQL.
 *
 * Needs a server, and skips without one, as the real-MySQL test of `mysql2` does. Disposable ones:
 *
 *     docker run -d --name dt-mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=dt -p 127.0.0.1:33306:3306 mysql:8.4
 *     docker run -d --name dt-mariadb -e MARIADB_ROOT_PASSWORD=pw -e MARIADB_DATABASE=dt -p 127.0.0.1:33307:3306 mariadb:11.4
 *     MYSQL_URL=mysql://root:pw@127.0.0.1:33306/dt pnpm --filter @downtrace/agent exec vitest run instrument-mariadb.integration
 */
const MYSQL_URL = process.env.MYSQL_URL;

if (!MYSQL_URL) {
  console.warn("[agent] MYSQL_URL not set: skipping the real-server tests of mariadb");
}

const handed: unknown[] = [];
const deps = { log: { warn: () => {}, debug: () => {} }, internalError: (err: unknown) => void handed.push(err) };
const current: { fingerprints?: FingerprintCache; errors?: ErrorFingerprintCache } = {};
const swapped = {
  ...deps,
  get fingerprints() {
    return current.fingerprints;
  },
  get errors() {
    return current.errors;
  },
};

function optionsOf(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    // MySQL 8's `caching_sha2_password` over a connection with no TLS.
    allowPublicKeyRetrieval: true,
  };
}

const COPIES: ReadonlyArray<readonly [name: string, copy: MariadbCopy]> = [
  ["mariadb 3.4, CommonJS", "mariadb34"],
  ["mariadb 3.5, ESM", "mariadb"],
];

describe.skipIf(!MYSQL_URL).each(COPIES)("%s against a real server", (_name, copy) => {
  let driver: Mariadb;
  // biome-ignore lint/suspicious/noExplicitAny: the driver's pool
  let pool: any;
  let target = "";

  beforeAll(async () => {
    driver = await loadMariadb(copy);
    current.fingerprints = new FingerprintCache(1000, "mysql");
    current.errors = new ErrorFingerprintCache();
    patchMariadbConnection(driver.Connection, "real", swapped);
    patchMariadbPool(driver.Pool, swapped);
    patchMariadbCallback(driver.ConnectionCallback, swapped);
    const options = optionsOf(MYSQL_URL ?? "");
    target = `${options.host}:${options.port}`;
    pool = driver.promise.createPool({ ...options, connectionLimit: 2 });
    // Set up outside any request, so none of it is counted.
    await pool.query("DROP TABLE IF EXISTS dt_users");
    await pool.query("CREATE TABLE dt_users (id INT PRIMARY KEY, email VARCHAR(100) UNIQUE)");
    await pool.query("INSERT INTO dt_users (id, email) VALUES (1, 'ana@cliente.com')");
  });

  afterAll(async () => {
    await pool?.query("DROP TABLE IF EXISTS dt_users");
    await pool?.end();
    expect(handed, "the instrumentation failed while recording").toEqual([]);
  });

  const work = (ctx: RequestContext) => ctx.work?.get(dependencyKey("mysql", target));
  const texts = (ctx: RequestContext) =>
    [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => [o.text, o.count, o.errors]);

  it("counts a prepared statement, the text as the application wrote it", async () => {
    const ctx = enterRequest();
    const rows = await pool.execute("SELECT email FROM dt_users WHERE id = ?", [1]);
    expect(rows[0]?.email).toBe("ana@cliente.com");
    expect(work(ctx)).toMatchObject({ calls: 1, errors: 0 });
    expect(texts(ctx)).toEqual([["SELECT email FROM dt_users WHERE id = ?", 1, 0]]);
  });

  it("counts a batch once, whatever the server makes of it", async () => {
    const ctx = enterRequest();
    await pool.batch("INSERT INTO dt_users (id, email) VALUES (?, ?)", [
      [10, "b-zq@cliente.com"],
      [11, "c-zq@cliente.com"],
    ]);
    expect(work(ctx)).toMatchObject({ calls: 1, errors: 0 });
    // A list of values is one placeholder in a fingerprint, however many the statement has.
    expect(texts(ctx)).toEqual([["INSERT INTO dt_users (id, email) VALUES (?)", 1, 0]]);
    expect(JSON.stringify([...(ctx.operations ?? [])])).not.toContain("zq@cliente.com");
  });

  it("counts a query Prisma's adapter would make, and the error the server answered", async () => {
    const ctx = enterRequest();
    await pool.query({ sql: "SELECT id FROM dt_users WHERE email = ?", rowsAsArray: true }, ["ana@cliente.com"]);
    const failure = await pool
      .query("INSERT INTO dt_users (id, email) VALUES (?, ?)", [2, "ana@cliente.com"])
      .catch((e: unknown) => e);
    expect((failure as { errno?: unknown }).errno).toBe(1062);
    expect(work(ctx)).toMatchObject({ calls: 2, errors: 1 });
    const signatures = [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "error");
    expect(signatures).toHaveLength(1);
    expect(JSON.stringify(signatures)).not.toContain("ana@cliente.com");
  });

  it("counts the statements of a transaction on a connection of the pool", async () => {
    const ctx = enterRequest();
    const connection = await pool.getConnection();
    try {
      await connection.query("BEGIN");
      await connection.query("UPDATE dt_users SET email = ? WHERE id = ?", ["d-zq@cliente.com", 1]);
      await connection.query("ROLLBACK");
    } finally {
      await connection.release();
    }
    expect(texts(ctx).map(([text]) => text)).toEqual([
      "BEGIN",
      "UPDATE dt_users SET email = ? WHERE id = ?",
      "ROLLBACK",
    ]);
  });
});
