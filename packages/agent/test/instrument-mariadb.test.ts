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
import { patchMariadbCallback, patchMariadbConnection, patchMariadbPool } from "../src/instrument/mariadb.ts";
import type { Logger } from "../src/log.ts";
import { loadMariadb, type Mariadb, type MariadbCopy, rootOf } from "./support/mariadb.ts";
import { type FakeMysql, type Reply, startFakeMysql } from "./support/mysql.ts";

/**
 * The `mariadb` observer: the real driver — the one Prisma's adapter for MySQL and MariaDB queries through, and
 * Sequelize's `mariadb` dialect — against the MySQL server of `support/mysql.ts`, asked what `mysql2`'s observer is
 * asked: whose query is it, how long did it wait for a connection, and what did it fail with.
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

const COPIES: ReadonlyArray<readonly [name: string, copy: MariadbCopy]> = [
  ["mariadb 3.4, CommonJS", "mariadb34"],
  ["mariadb 3.5, ESM", "mariadb"],
];

/** Credentials and a database that must never be what a dependency is called. */
const SECRET_USER = "dt-user-zq";
const SECRET_PASSWORD = "hunter2-zq";
const SECRET_DATABASE = "payroll-zq";

interface Rig {
  driver: Mariadb;
  server: FakeMysql;
  target: string;
  fingerprints: FingerprintCache;
  errors: ErrorFingerprintCache;
  options: Record<string, unknown>;
}

/**
 * A server, a copy of the driver and the observer on it. The fingerprints and the errors are the caches of this
 * rig: an ES module's classes are patched once, with the caches of the first rig, so each rig passes its own
 * through `swap`, which every patch reads when a query runs.
 */
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

async function rig(copy: MariadbCopy, handler?: (sql: string) => Reply): Promise<Rig> {
  const server = await startFakeMysql(handler);
  cleanups.push(() => server.close());
  const driver = await loadMariadb(copy);
  current.fingerprints = new FingerprintCache(1000, "mysql");
  current.errors = new ErrorFingerprintCache();
  expect(patchMariadbConnection(driver.Connection, "test", swapped)).toBe(true);
  expect(patchMariadbPool(driver.Pool, swapped)).toBe(true);
  expect(patchMariadbCallback(driver.ConnectionCallback, swapped)).toBe(true);
  const options = {
    host: server.host,
    port: server.port,
    user: SECRET_USER,
    password: SECRET_PASSWORD,
    database: SECRET_DATABASE,
    connectTimeout: 2000,
  };
  return {
    driver,
    server,
    target: `${server.host}:${server.port}`,
    fingerprints: current.fingerprints,
    errors: current.errors,
    options,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the driver's pool, as the application holds it
function pool(r: Rig, extra: Record<string, unknown> = {}): any {
  const made = r.driver.promise.createPool({ ...r.options, connectionLimit: 2, ...extra });
  cleanups.push(() => made.end());
  return made;
}

const work = (ctx: RequestContext, target: string) => ctx.work?.get(dependencyKey("mysql", target));
const queriesOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => o.text);

describe.each(COPIES)("%s", (_name, copy) => {
  describe("a query counts against the request that asked", () => {
    it("is a call of the dependency `mysql`, named by host and port, with the text the application wrote", async () => {
      const r = await rig(copy);
      const db = pool(r);
      const ctx = enterRequest();
      const rows = await db.query("SELECT ? AS one", [1]);
      expect(rows).toHaveLength(1);

      // The connection's own `SET NAMES`, sent before it was handed over, is not the request's.
      expect([...(ctx.work?.values() ?? [])]).toHaveLength(1);
      expect(work(ctx, r.target)).toMatchObject({ kind: "mysql", target: r.target, calls: 1, errors: 0 });
      expect(queriesOf(ctx)).toEqual(["SELECT ? AS one"]);
      // The driver put the value into the text it sent; the operation is the template.
      expect(r.server.received).toContain("SELECT 1 AS one");
      const serialised = JSON.stringify([...(ctx.work ?? [])]) + JSON.stringify([...(ctx.operations ?? [])]);
      for (const secret of [SECRET_USER, SECRET_PASSWORD, SECRET_DATABASE]) expect(serialised).not.toContain(secret);
    });

    it("reads the text of an options object, which is how Prisma's adapter asks", async () => {
      const r = await rig(copy);
      const connection = await r.driver.promise.createConnection(r.options);
      cleanups.push(() => connection.end());
      const ctx = enterRequest();
      await connection.query({ sql: "SELECT ? AS one", rowsAsArray: true }, [1]);
      await connection.query({ sql: "SELECT ? AS one", rowsAsArray: true }, [2]);
      expect(work(ctx, r.target)?.calls).toBe(2);
      expect([...(ctx.operations?.values() ?? [])].map((o) => [o.text, o.count])).toEqual([["SELECT ? AS one", 2]]);
    });

    it("runs a callback in the request that asked, not in the one that opened the connection", async () => {
      const r = await rig(copy);
      const opened = enterRequest();
      // biome-ignore lint/suspicious/noExplicitAny: the callback API's connection
      const connection: any = await new Promise((resolve, reject) => {
        const made = r.driver.callback.createConnection(r.options);
        made.connect((err: unknown) => (err ? reject(err) : resolve(made)));
      });
      cleanups.push(() => new Promise<void>((resolve) => connection.end(() => resolve())));
      const asked = enterRequest();
      await new Promise<void>((resolve, reject) =>
        connection.query("SELECT 1", (err: unknown) => {
          if (err) return reject(err);
          // The callback API's whole shape: the next query is asked from inside the callback.
          expect(currentContext()).toBe(asked);
          connection.query("SELECT 2", (again: unknown) => (again ? reject(again) : resolve()));
        }),
      );
      expect(work(asked, r.target)?.calls).toBe(2);
      expect(opened.work).toBeUndefined();
    });

    it("does not count work outside a request, and does not look at its text", async () => {
      const r = await rig(copy);
      const db = pool(r);
      expect(currentContext()).toBeUndefined();
      await db.query("SELECT 1");
      expect(r.fingerprints.size).toBe(0);
    });
  });

  describe("a query that fails", () => {
    it("is a failed call and a failed operation, with a signature that carries no value", async () => {
      const r = await rig(copy, (sql) =>
        /INSERT/.test(sql)
          ? { error: { code: 1062, message: "Duplicate entry 'ana@cliente.com' for key 'users.email'" } }
          : {},
      );
      const db = pool(r);
      const ctx = enterRequest();
      const failure = await db
        .query("INSERT INTO users (email) VALUES (?)", ["ana@cliente.com"])
        .catch((e: unknown) => e);
      expect((failure as { errno?: unknown }).errno, "the application gets the driver's error").toBe(1062);
      expect(work(ctx, r.target)).toMatchObject({ calls: 1, errors: 1 });
      const operations = [...(ctx.operations?.values() ?? [])];
      expect(operations.find((o) => o.kind === "query")).toMatchObject({
        text: "INSERT INTO users (email) VALUES (?)",
        count: 1,
        errors: 1,
      });
      const signatures = operations.filter((o) => o.kind === "error");
      expect(signatures).toHaveLength(1);
      expect(JSON.stringify(signatures)).not.toContain("ana@cliente.com");
    });

    it("counts `execute` and `batch`, which prepare first, as the query the application wrote", async () => {
      // The server of these tests prepares nothing, so both fail; what is asked of the observer is that the
      // application's statement is counted, once, as its own.
      const r = await rig(copy);
      const db = pool(r);
      const ctx = enterRequest();
      await db.execute("SELECT * FROM users WHERE id = ?", [7]).catch(() => {});
      await db.batch("INSERT INTO users (id) VALUES (?)", [[1], [2]]).catch(() => {});
      expect(queriesOf(ctx).sort()).toEqual(["INSERT INTO users (id) VALUES (?)", "SELECT * FROM users WHERE id = ?"]);
      expect(work(ctx, r.target)).toMatchObject({ calls: 2, errors: 2 });
    });
  });

  describe("waiting for a connection", () => {
    it("times the wait of a request the pool had no connection for, and its query is its own", async () => {
      const r = await rig(copy, (sql) => (/SLOW/.test(sql) ? { delayMs: 150 } : {}));
      const db = pool(r, { connectionLimit: 1 });
      await db.query("SELECT 0"); // the one connection, opened outside any request
      const first = enterRequest();
      const holding = db.query("SELECT 1 AS SLOW");
      const second = enterRequest();
      const waiting = db.query("SELECT 2");
      await Promise.all([holding, waiting]);

      expect(queriesOf(first)).toEqual(["SELECT ? AS SLOW"]);
      expect(queriesOf(second), "the query the pool ran when the first gave the connection back").toEqual(["SELECT ?"]);
      expect(work(second, r.target)?.waitMs).toBeGreaterThan(100);
      expect(work(first, r.target)?.waitMs).toBeLessThan(100);
    });
  });
});

describe("the application sees what it sees without the observer", () => {
  it("gets the same rows, the same error and the same wire", async () => {
    const seen = async (instrumented: boolean) => {
      const server = await startFakeMysql((sql) => (/boom/.test(sql) ? { error: { code: 1064, message: "no" } } : {}));
      cleanups.push(() => server.close());
      const driver = await loadMariadb("mariadb34");
      if (instrumented) {
        patchMariadbConnection(driver.Connection, "test", deps);
        patchMariadbPool(driver.Pool, deps);
        patchMariadbCallback(driver.ConnectionCallback, deps);
      }
      const db = driver.promise.createPool({ host: server.host, port: server.port, user: "u", connectionLimit: 1 });
      cleanups.push(() => db.end());
      enterRequest();
      const ok = await db.query("SELECT ? AS one", [1]);
      const failed = await db
        .query("boom")
        .catch((e: Error) => ({ errno: (e as { errno?: unknown }).errno, text: e.message }));
      return {
        ok: JSON.stringify(ok, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
        failed,
        wire: server.received,
      };
    };
    const bare = await seen(false);
    expect(await seen(true)).toEqual(bare);
  });
});

describe("patchMariadbConnection and patchMariadbPool", () => {
  it("patch once, however many times they are asked", async () => {
    const driver = await loadMariadb("mariadb34");
    const proto = (driver.Connection as { prototype: Record<string, unknown> }).prototype;
    expect(patchMariadbConnection(driver.Connection, "test", deps)).toBe(true);
    const query = proto.query;
    expect(patchMariadbConnection(driver.Connection, "test", deps)).toBe(true);
    expect(proto.query).toBe(query);
    const poolProto = (driver.Pool as { prototype: Record<string, unknown> }).prototype;
    expect(patchMariadbPool(driver.Pool, deps)).toBe(true);
    const getConnection = poolProto.getConnection;
    expect(patchMariadbPool(driver.Pool, deps)).toBe(true);
    expect(poolProto.getConnection).toBe(getConnection);
  });

  it("refuse what is not the driver's class, and say so", () => {
    const said: string[] = [];
    const log: Logger = { warn: () => {}, debug: (line) => said.push(line) };
    expect(patchMariadbConnection(class {}, "test", { ...deps, log })).toBe(false);
    expect(patchMariadbConnection(undefined, "test", { ...deps, log })).toBe(false);
    expect(patchMariadbPool(class {}, { ...deps, log })).toBe(false);
    expect(said).toHaveLength(3);
  });
});

/** Runs a module of its own, in a process of its own, and returns what it printed. */
async function runAlone(script: string, args: string[]): Promise<string[]> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
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

describe("armMariadb, the start-up half", () => {
  const src = fileURLToPath(new URL("../src/instrument/mariadb.ts", import.meta.url));
  /** An application with the copy installed as `mariadb`, or with nothing. */
  async function application(copy: MariadbCopy | undefined): Promise<{ dir: string; entry: string }> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "downtrace-armmariadb-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    if (copy !== undefined) await symlink(rootOf(copy), path.join(dir, "node_modules", "mariadb"), "dir");
    const entry = path.join(dir, "app.mjs");
    await writeFile(entry, "");
    return { dir, entry };
  }
  /** Arms from the application, loads the driver as it would, attaches, and says whether its classes are patched. */
  const script = (load: string) => `
    import { realpathSync } from "node:fs";
    import { createRequire } from "node:module";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import { armMariadb } from ${JSON.stringify(src)};
    const entry = process.argv[1];
    const armed = armMariadb({
      log: { warn: () => {}, debug: () => {} },
      internalError: (err) => { console.error(String(err)); process.exit(2); },
      from: entry,
    });
    console.log(armed.state);
    const require = createRequire(entry);
    const root = realpathSync(path.join(path.dirname(entry), "node_modules", "mariadb"));
    // Its package.json is read at start-up, to know its version and its layout; none of its code is.
    const loaded = () => Object.keys(require.cache).some((key) => key.startsWith(root + path.sep) && !key.endsWith("package.json"));
    console.log(loaded() ? "loaded" : "not loaded");
    ${load}
    console.log(armed.attach());
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.log(armed.attach());
    const mark = Symbol.for("downtrace.mariadb.instrumented");
    const Connection = require.cache[path.join(root, "lib", "connection.js")]?.exports
      ?? (await import(pathToFileURL(path.join(root, "lib", "connection.js")).href)).default;
    console.log(Connection.prototype[mark] === true ? "patched" : "not patched");
  `;

  it("resolves 3.4 without loading it, and patches it once the application has required it", async () => {
    const app = await application("mariadb34");
    const lines = await runAlone(script(`require("mariadb");`), [app.entry]);
    expect(lines).toEqual(["on", "not loaded", "true", "true", "patched"]);
  });

  it("imports the classes of 3.5 by their URL, the modules the application's `import` loads", async () => {
    const app = await application("mariadb");
    const lines = await runAlone(script(`await import(pathToFileURL(path.join(root, "promise.js")).href);`), [
      app.entry,
    ]);
    // The first attach asks for the import; the one after it has resolved settles.
    expect(lines).toEqual(["on", "not loaded", "false", "true", "patched"]);
  });

  it("says so when the application requires 3.5 from its CommonJS bundle, whose classes it cannot reach", async () => {
    const app = await application("mariadb");
    const lines = await runAlone(
      `
      import { createRequire } from "node:module";
      import { armMariadb } from ${JSON.stringify(src)};
      const said = [];
      const armed = armMariadb({
        log: { warn: () => {}, debug: (line) => said.push(line) },
        internalError: (err) => { console.error(String(err)); process.exit(2); },
        from: process.argv[1],
      });
      createRequire(process.argv[1])("mariadb");
      armed.attach();
      await new Promise((resolve) => setTimeout(resolve, 200));
      console.log(armed.attach());
      console.log(said.filter((line) => line.includes("CommonJS bundle")).length);
    `,
      [app.entry],
    );
    expect(lines).toEqual(["true", "1"]);
  });

  it("is unavailable when the application has no mariadb, and its attach settles at once", async () => {
    const app = await application(undefined);
    const lines = await runAlone(
      `
      import { armMariadb } from ${JSON.stringify(src)};
      const armed = armMariadb({ log: { warn: () => {}, debug: () => {} }, internalError: () => process.exit(2), from: process.argv[1] });
      console.log(armed.state);
      console.log(armed.attach());
    `,
      [app.entry],
    );
    expect(lines).toEqual(["unavailable", "true"]);
  });
});

describe("Prisma's adapter, over the CommonJS bundle the driver's `require` loads from 3.5.3", () => {
  const here = (file: string) => JSON.stringify(fileURLToPath(new URL(file, import.meta.url)));
  const ADAPTER = path.dirname(path.dirname(createRequire(import.meta.url).resolve("@prisma/adapter-mariadb")));
  /** An application with Prisma's adapter installed, the real one or one of the test's own. */
  async function application(adapter: "real" | "over 3.4"): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "downtrace-prismamariadb-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "node_modules", "@prisma"), { recursive: true });
    const installed = path.join(dir, "node_modules", "@prisma", "adapter-mariadb");
    if (adapter === "real") {
      await symlink(ADAPTER, installed, "dir");
    } else {
      // The shape of the adapter, over the driver's CommonJS modules: what Prisma 7.0 to 7.9 bring.
      await mkdir(installed);
      await writeFile(
        path.join(installed, "package.json"),
        JSON.stringify({ name: "@prisma/adapter-mariadb", main: "index.js" }),
      );
      await writeFile(
        path.join(installed, "index.js"),
        `require("mariadb");
        class Queryable { async performIO() { return []; } }
        class PrismaMariaDb { async connect() { return new Queryable(); } }
        module.exports = { PrismaMariaDb };`,
      );
      await symlink(rootOf("mariadb34"), path.join(dir, "node_modules", "mariadb"), "dir");
    }
    const entry = path.join(dir, "app.cjs");
    await writeFile(entry, "");
    return entry;
  }
  const preamble = `
    import { createRequire } from "node:module";
    import { watchPrismaMariadb } from ${here("../src/instrument/mariadb.ts")};
    import { dependencyKey, enterRequest } from ${here("../src/context.ts")};
    import { FingerprintCache } from ${here("../src/fingerprint.ts")};
    import { startFakeMysql } from ${here("./support/mysql.ts")};
    const deps = {
      log: { warn: () => {}, debug: () => {} },
      internalError: (err) => { console.error(String(err)); process.exit(2); },
      fingerprints: new FingerprintCache(100, "mysql"),
      from: process.argv[1],
    };
    const require = createRequire(process.argv[1]);
  `;
  /** Prisma's queries through the adapter, one that the server answers and one it refuses, in one request. */
  const queries = `
    const server = await startFakeMysql((sql) => (/boom/.test(sql) ? { error: { code: 1064, message: "no" } } : {}));
    const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
    const adapter = await new PrismaMariaDb(
      { host: "127.0.0.1", port: server.port, user: "app", connectionLimit: 1 },
      { useTextProtocol: true },
    ).connect();
    const ctx = enterRequest();
    await adapter.queryRaw({ sql: "SELECT id FROM users WHERE id = ?", args: [7], argTypes: [{ scalarType: "int", arity: "scalar" }] });
    const failed = await adapter.executeRaw({ sql: "boom", args: [], argTypes: [] }).then(() => "resolved", (err) => err.name);
    const work = ctx.work?.get(dependencyKey("mysql", ""));
    console.log(JSON.stringify({
      calls: work?.calls,
      errors: work?.errors,
      first: [...(ctx.operations?.values() ?? [])].find((o) => o.kind === "query")?.text,
      failed,
    }));
    await adapter.dispose();
    await server.close();
  `;
  const expected = {
    calls: 2,
    errors: 1,
    first: "SELECT id FROM users WHERE id = ?",
    failed: "DriverAdapterError",
  };

  it("counts the queries Prisma sends through it, in the request that sent them", async () => {
    const entry = await application("real");
    const lines = await runAlone(`${preamble} const stop = watchPrismaMariadb(deps); ${queries} stop();`, [entry]);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toEqual(expected);
  });

  it("patches an adapter the application had loaded before the instrumentation started", async () => {
    const entry = await application("real");
    const lines = await runAlone(
      `${preamble} require("@prisma/adapter-mariadb"); const stop = watchPrismaMariadb(deps); ${queries} stop();`,
      [entry],
    );
    expect(JSON.parse(lines.at(-1) ?? "{}")).toEqual(expected);
  });

  it("leaves alone an adapter over the driver's own modules, which the driver's observer counts", async () => {
    const entry = await application("over 3.4");
    const lines = await runAlone(
      `${preamble}
      const stop = watchPrismaMariadb(deps);
      const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
      console.log(Object.getOwnPropertySymbols(PrismaMariaDb.prototype).length === 0 ? "untouched" : "patched");
      stop();`,
      [entry],
    );
    expect(lines).toEqual(["untouched"]);
  });
});
