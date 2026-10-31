import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { currentContext, dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { patchMssql, patchTedious } from "../src/instrument/mssql.ts";
import type { Logger } from "../src/log.ts";
import { type FakeMssql, type MssqlReply, startFakeMssql } from "./support/mssql.ts";

/**
 * The SQL Server observer (ADR 0245): the real `tedious`, and `mssql` over it — the driver TypeORM, Knex and Prisma's
 * adapter for SQL Server query through, and Sequelize's `mssql` dialect calls itself — against the SQL Server of
 * `support/mssql.ts`, asked what the other observers are asked: whose statement is it, what did it fail with, and what
 * did the application see.
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };
const handed: unknown[] = [];
const deps = {
  log: quiet,
  internalError: (err: unknown): void => {
    handed.push(err);
  },
};

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  expect(handed.splice(0), "the instrumentation failed while recording").toEqual([]);
  while (cleanups.length) await cleanups.pop()?.();
});

const require = createRequire(import.meta.url);
const TEDIOUS_ROOT = path.dirname(path.dirname(require.resolve("tedious")));

/** Its own copy of `tedious`, and of `mssql` over it, so that each test patches classes no other test has. */
// biome-ignore lint/suspicious/noExplicitAny: the driver's own types are not what these tests are about
function freshDrivers(): { tedious: any; mssql: any } {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]node_modules[\\/](tedious|mssql)[\\/]/.test(key)) delete require.cache[key];
  }
  return { tedious: require("tedious"), mssql: require("mssql") };
}

/** Credentials and a database that must never be what a dependency is called. */
const SECRET_USER = "dt-user-zq";
const SECRET_PASSWORD = "hunter2-zq";
const SECRET_DATABASE = "payroll-zq";

interface Rig {
  // biome-ignore lint/suspicious/noExplicitAny: as above
  tedious: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  mssql: any;
  server: FakeMssql;
  target: string;
  fingerprints: FingerprintCache;
}

async function rig(handler?: (sql: string) => MssqlReply, options: { instrumented?: boolean } = {}): Promise<Rig> {
  const server = await startFakeMssql(handler);
  cleanups.push(() => server.close());
  const { tedious, mssql } = freshDrivers();
  const fingerprints = new FingerprintCache(1000, "mssql");
  if (options.instrumented !== false) {
    expect(patchTedious(tedious, "test", { ...deps, fingerprints, errors: new ErrorFingerprintCache() })).toBe(true);
    expect(patchMssql(mssql, deps)).toBe(true);
  }
  return { tedious, mssql, server, target: `${server.host}:${server.port}`, fingerprints };
}

// biome-ignore lint/suspicious/noExplicitAny: a tedious Connection
async function connect(r: Rig): Promise<any> {
  const connection = new r.tedious.Connection({
    server: r.server.host,
    options: { port: r.server.port, database: SECRET_DATABASE, encrypt: false, connectTimeout: 3000 },
    authentication: { type: "default", options: { userName: SECRET_USER, password: SECRET_PASSWORD } },
  });
  await new Promise<void>((resolve, reject) => {
    connection.on("connect", (err: unknown) => (err ? reject(err) : resolve()));
    connection.connect();
  });
  cleanups.push(() => connection.close());
  return connection;
}

/** One statement through `execSql`, with its parameters, settled. */
// biome-ignore lint/suspicious/noExplicitAny: as above
function run(r: Rig, connection: any, sql: string, params: Record<string, number> = {}, batch = false) {
  return new Promise<{ err: unknown; count: unknown }>((resolve) => {
    const request = new r.tedious.Request(sql, (err: unknown, count: unknown) => resolve({ err, count }));
    for (const [name, value] of Object.entries(params)) request.addParameter(name, r.tedious.TYPES.Int, value);
    if (batch) connection.execSqlBatch(request);
    else connection.execSql(request);
  });
}

const work = (ctx: RequestContext, target: string) => ctx.work?.get(dependencyKey("mssql", target));
const queriesOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => o.text);

describe("a statement through tedious counts against the request that asked", () => {
  it("is a call of the dependency `mssql`, named by host and port, with the text as T-SQL reads it", async () => {
    const r = await rig();
    const connection = await connect(r);
    const ctx = enterRequest();
    const { err, count } = await run(r, connection, "SELECT [id] FROM [users] WHERE [id] = @id", { id: 7 });
    expect(err).toBeUndefined();
    expect(count).toBe(1);

    // The options the connection set as it logged in are its own, and were not asked for by the request.
    expect(r.server.received[0]).toMatch(/^set /);
    expect([...(ctx.work?.values() ?? [])]).toHaveLength(1);
    expect(work(ctx, r.target)).toMatchObject({ kind: "mssql", target: r.target, calls: 1, errors: 0 });
    expect(queriesOf(ctx)).toEqual(["SELECT [id] FROM [users] WHERE [id] = ?"]);
    const serialised = JSON.stringify([...(ctx.work ?? [])]) + JSON.stringify([...(ctx.operations ?? [])]);
    for (const secret of [SECRET_USER, SECRET_PASSWORD, SECRET_DATABASE]) expect(serialised).not.toContain(secret);
  });

  it("counts a batch, as `execSqlBatch` sends it", async () => {
    const r = await rig();
    const connection = await connect(r);
    const ctx = enterRequest();
    await run(r, connection, "SELECT 1 AS one", {}, true);
    expect(queriesOf(ctx)).toEqual(["SELECT ? AS one"]);
  });

  it("runs the callback in the request that asked, not in the one that opened the connection", async () => {
    const r = await rig();
    const opened = enterRequest();
    const connection = await connect(r);
    const asked = enterRequest();
    await new Promise<void>((resolve, reject) => {
      const first = new r.tedious.Request("SELECT 1", (err: unknown) => {
        if (err) return reject(err);
        expect(currentContext()).toBe(asked);
        // The callback API's shape: the next statement is asked from inside the callback.
        connection.execSql(new r.tedious.Request("SELECT 2", (again: unknown) => (again ? reject(again) : resolve())));
      });
      connection.execSql(first);
    });
    expect(work(asked, r.target)?.calls).toBe(2);
    expect(opened.work).toBeUndefined();
  });

  it("counts the round trips of a transaction as calls, with no text of their own", async () => {
    const r = await rig();
    const connection = await connect(r);
    const ctx = enterRequest();
    await new Promise<void>((resolve, reject) =>
      connection.beginTransaction((e: unknown) => (e ? reject(e) : resolve())),
    );
    await run(r, connection, "UPDATE [users] SET [name] = @id", { id: 1 });
    await new Promise<void>((resolve, reject) =>
      connection.commitTransaction((e: unknown) => (e ? reject(e) : resolve())),
    );
    expect(work(ctx, r.target)?.calls).toBe(3);
    expect(queriesOf(ctx)).toEqual(["UPDATE [users] SET [name] = ?"]);
  });

  it("does not count work outside a request, and does not look at its text", async () => {
    const r = await rig();
    const connection = await connect(r);
    await run(r, connection, "SELECT 1");
    expect(r.fingerprints.size).toBe(0);
  });

  it("wraps the callback of a request run twice once, and counts each run", async () => {
    const r = await rig();
    const connection = await connect(r);
    const ctx = enterRequest();
    let calls = 0;
    const request = new r.tedious.Request("SELECT 1", () => {
      calls += 1;
    });
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => {
        request.once("requestCompleted", () => resolve());
        connection.execSqlBatch(request);
      });
    }
    expect(calls).toBe(3);
    expect(work(ctx, r.target)?.calls).toBe(3);
  });
});

describe("a statement that fails", () => {
  it("is a failed call and a failed operation, with a signature that carries no value", async () => {
    const r = await rig((sql) =>
      /INSERT/.test(sql) ? { error: { number: 2627, message: "Violation of PRIMARY KEY 'ana@cliente.com'" } } : {},
    );
    const connection = await connect(r);
    const ctx = enterRequest();
    const { err } = await run(r, connection, "INSERT INTO [users] ([id]) VALUES (@id)", { id: 7 });
    expect((err as { number?: unknown }).number, "the application gets the driver's error").toBe(2627);
    expect(work(ctx, r.target)).toMatchObject({ calls: 1, errors: 1 });
    const operations = [...(ctx.operations?.values() ?? [])];
    expect(operations.find((o) => o.kind === "query")).toMatchObject({ count: 1, errors: 1 });
    const signatures = operations.filter((o) => o.kind === "error");
    expect(signatures).toHaveLength(1);
    expect(JSON.stringify(signatures)).not.toContain("ana@cliente.com");
  });
});

describe("through mssql, the package most applications hold", () => {
  it("counts a pool's query in the request that asked, with the text as T-SQL reads it", async () => {
    const r = await rig();
    const pool = await new r.mssql.ConnectionPool({
      server: r.server.host,
      port: r.server.port,
      user: SECRET_USER,
      password: SECRET_PASSWORD,
      options: { encrypt: false },
    }).connect();
    cleanups.push(() => pool.close());
    const ctx = enterRequest();
    const result = await pool.request().input("id", r.mssql.Int, 3).query("SELECT [id] FROM [orders] WHERE [id] = @id");
    expect(result.recordset).toEqual([{ one: 1 }]);
    // The pool validated the connection it handed over with a `SELECT 1;` of its own, which no route wrote.
    expect(r.server.received).toContain("SELECT 1;");
    expect(work(ctx, r.target)?.calls).toBe(1);
    expect(queriesOf(ctx)).toEqual(["SELECT [id] FROM [orders] WHERE [id] = ?"]);
  });
});

describe("a statement mssql prepares", () => {
  it("is each statement it was prepared with, and not one `sp_execute` for all of them, prepared outside a request", async () => {
    const r = await rig();
    const pool = await new r.mssql.ConnectionPool({
      server: r.server.host,
      port: r.server.port,
      user: SECRET_USER,
      password: SECRET_PASSWORD,
      options: { encrypt: false },
      // Each prepared statement holds a connection of its own until it is unprepared.
      pool: { max: 2 },
    }).connect();
    cleanups.push(() => pool.close());
    const prepare = async (sql: string) => {
      const statement = new r.mssql.PreparedStatement(pool);
      statement.input("id", r.mssql.Int);
      await statement.prepare(sql);
      return statement;
    };
    // Prepared at start-up, as an application does, outside any request.
    const orders = await prepare("SELECT [id] FROM [orders] WHERE [id] = @id");
    const users = await prepare("SELECT [id] FROM [users] WHERE [id] = @id");
    const ctx = enterRequest();
    await orders.execute({ id: 1 });
    await orders.execute({ id: 2 });
    await users.execute({ id: 3 });
    await orders.unprepare();
    await users.unprepare();
    const counts = Object.fromEntries(
      [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => [o.text, o.count]),
    );
    expect(counts).toEqual({
      "SELECT [id] FROM [orders] WHERE [id] = ?": 2,
      "SELECT [id] FROM [users] WHERE [id] = ?": 1,
      sp_unprepare: 2,
    });
  });
});

describe("the application sees what it sees without the observer", () => {
  it("gets the same results, the same error and the same wire", async () => {
    const seen = async (instrumented: boolean) => {
      const r = await rig((sql) => (/boom/.test(sql) ? { error: { number: 102, message: "no" } } : {}), {
        instrumented,
      });
      const connection = await connect(r);
      enterRequest();
      const ok = await run(r, connection, "SELECT @id AS one", { id: 1 });
      const failed = await run(r, connection, "boom");
      const err = failed.err as { message?: unknown; number?: unknown; code?: unknown };
      return { ok, failed: { message: err.message, number: err.number, code: err.code }, wire: r.server.received };
    };
    const bare = await seen(false);
    expect(await seen(true)).toEqual(bare);
  });
});

describe("patchTedious", () => {
  it("patches once, however many times it is asked", () => {
    const { tedious } = freshDrivers();
    expect(patchTedious(tedious, "test", deps)).toBe(true);
    const makeRequest = tedious.Connection.prototype.makeRequest;
    expect(patchTedious(tedious, "test", deps)).toBe(true);
    expect(tedious.Connection.prototype.makeRequest).toBe(makeRequest);
  });

  it("refuses what is not the driver, and says so", () => {
    const said: string[] = [];
    const log: Logger = { warn: () => {}, debug: (line) => said.push(line) };
    expect(patchTedious({ Connection: class {} }, "test", { ...deps, log })).toBe(false);
    expect(patchTedious(undefined, "test", { ...deps, log })).toBe(false);
    expect(said).toHaveLength(2);
  });
});

describe("armTedious, the start-up half", () => {
  const src = fileURLToPath(new URL("../src/instrument/mssql.ts", import.meta.url));
  async function application(installed: boolean): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "downtrace-armtedious-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    if (installed) await symlink(TEDIOUS_ROOT, path.join(dir, "node_modules", "tedious"), "dir");
    const entry = path.join(dir, "app.cjs");
    await writeFile(entry, "");
    return entry;
  }
  async function runAlone(script: string, entry: string): Promise<string[]> {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, entry], {
      env: { ...process.env, NODE_PATH: "" },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString();
    });
    const code = await new Promise<number>((resolve) => child.on("exit", resolve));
    expect(code, out).toBe(0);
    return out.trim().split("\n");
  }
  const script = (load: string) => `
    import { createRequire } from "node:module";
    import { armTedious } from ${JSON.stringify(src)};
    const armed = armTedious({
      log: { warn: () => {}, debug: () => {} },
      internalError: (err) => { console.error(String(err)); process.exit(2); },
      from: process.argv[1],
    });
    console.log(armed.state);
    const require = createRequire(process.argv[1]);
    console.log(Object.keys(require.cache).some((key) => key.includes("tedious${path.sep}lib")) ? "loaded" : "not loaded");
    ${load}
    console.log(armed.attach());
  `;

  it("resolves the driver without loading it, and patches it once the application has", async () => {
    const entry = await application(true);
    const lines = await runAlone(
      script(`
      const tedious = require("tedious");
      console.log(Object.getOwnPropertySymbols(tedious.Connection.prototype).length > 0 ? "patched" : "not patched");`)
        .replace("console.log(armed.attach());", "")
        .concat(`console.log(armed.attach());
      console.log(Object.getOwnPropertySymbols(require("tedious").Connection.prototype).length > 0 ? "patched" : "not patched");`),
      entry,
    );
    expect(lines).toEqual(["on", "not loaded", "not patched", "true", "patched"]);
  });

  it("is unavailable when the application has no tedious, and its attach settles at once", async () => {
    const entry = await application(false);
    const lines = await runAlone(script(""), entry);
    expect(lines).toEqual(["unavailable", "not loaded", "true"]);
  });
});
