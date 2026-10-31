import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { currentContext, dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { patchMysql } from "../src/instrument/mysql.ts";
import type { Logger } from "../src/log.ts";
import { type FakeMysql, type Reply, startFakeMysql } from "./support/mysql.ts";

/**
 * MySQL through `mysql` (mysqljs), the driver `mysql2` was written to replace and that TypeORM still loads first, Knex's
 * `mysql` client, and the Express applications of the last decade. Its API is the one `mysql2` copied, so it is observed
 * by the same observer (`mysql.ts`), asked the same questions against the same server — with what is its own: the query
 * its pool hands a connection carries its callback as `_callback`, and its classes are loaded only when they are first
 * used.
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
const MYSQLJS_ROOT = path.dirname(require.resolve("mysql/package.json"));

/** Its own copy of the driver and of the classes it loads when first used, which no other test has patched. */
// biome-ignore lint/suspicious/noExplicitAny: the driver's own types are not what these tests are about
function freshMysqljs(): { mysql: any; Connection: unknown; Pool: unknown } {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MYSQLJS_ROOT + path.sep)) delete require.cache[key];
  }
  return {
    mysql: require("mysql"),
    Connection: require(path.join(MYSQLJS_ROOT, "lib", "Connection.js")),
    Pool: require(path.join(MYSQLJS_ROOT, "lib", "Pool.js")),
  };
}

const SECRET_USER = "dt-user-zq";
const SECRET_PASSWORD = "hunter2-zq";
const SECRET_DATABASE = "payroll-zq";

interface Rig {
  // biome-ignore lint/suspicious/noExplicitAny: as above
  mysql: any;
  server: FakeMysql;
  target: string;
  fingerprints: FingerprintCache;
  options: Record<string, unknown>;
}

async function rig(handler?: (sql: string) => Reply, options: { instrumented?: boolean } = {}): Promise<Rig> {
  const server = await startFakeMysql(handler);
  cleanups.push(() => server.close());
  const { mysql, Connection, Pool } = freshMysqljs();
  const fingerprints = new FingerprintCache(1000, "mysql");
  if (options.instrumented !== false) {
    expect(
      patchMysql({ Connection, Pool }, "test", { ...deps, fingerprints, errors: new ErrorFingerprintCache() }),
    ).toBe(true);
  }
  return {
    mysql,
    server,
    target: `${server.host}:${server.port}`,
    fingerprints,
    options: {
      host: server.host,
      port: server.port,
      user: SECRET_USER,
      password: SECRET_PASSWORD,
      database: SECRET_DATABASE,
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a mysqljs connection or pool
function ask(on: any, sql: string, values?: unknown[]): Promise<{ err: unknown; rows: unknown }> {
  return new Promise((resolve) => {
    const callback = (err: unknown, rows: unknown) => resolve({ err, rows });
    if (values === undefined) on.query(sql, callback);
    else on.query(sql, values, callback);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: as above
function connect(r: Rig): any {
  const connection = r.mysql.createConnection(r.options);
  cleanups.push(() => connection.destroy());
  return connection;
}

// biome-ignore lint/suspicious/noExplicitAny: as above
function pool(r: Rig, extra: Record<string, unknown> = {}): any {
  const made = r.mysql.createPool({ ...r.options, connectionLimit: 2, ...extra });
  cleanups.push(() => new Promise<void>((resolve) => made.end(() => resolve())));
  return made;
}

const work = (ctx: RequestContext, target: string) => ctx.work?.get(dependencyKey("mysql", target));
const queriesOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => o.text);

describe("a query through mysqljs counts against the request that asked", () => {
  it("is a call of the dependency `mysql`, with the text the application wrote and not the one the driver sent", async () => {
    const r = await rig();
    const connection = connect(r);
    const ctx = enterRequest();
    const { err, rows } = await ask(connection, "SELECT * FROM users WHERE email = ?", ["ana@cliente.com"]);
    expect(err).toBeNull();
    expect(rows).toHaveLength(1);
    // mysqljs puts the values into the text before it sends it.
    expect(r.server.received).toContain("SELECT * FROM users WHERE email = 'ana@cliente.com'");
    expect(work(ctx, r.target)).toMatchObject({ kind: "mysql", target: r.target, calls: 1, errors: 0 });
    expect(queriesOf(ctx)).toEqual(["SELECT * FROM users WHERE email = ?"]);
    const serialised = JSON.stringify([...(ctx.work ?? [])]) + JSON.stringify([...(ctx.operations ?? [])]);
    for (const secret of [SECRET_USER, SECRET_PASSWORD, SECRET_DATABASE, "ana@cliente.com"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("counts a pool's query once, the query the pool hands the connection with its callback inside", async () => {
    const r = await rig();
    const db = pool(r);
    const ctx = enterRequest();
    await ask(db, "SELECT id FROM orders WHERE id = ?", [7]);
    await ask(db, "SELECT id FROM orders WHERE id = ?", [8]);
    expect(work(ctx, r.target)?.calls).toBe(2);
    expect([...(ctx.operations?.values() ?? [])].map((o) => [o.text, o.count])).toEqual([
      ["SELECT id FROM orders WHERE id = ?", 2],
    ]);
  });

  it("runs the callback in the request that asked, not in the one that opened the connection", async () => {
    const r = await rig();
    const opened = enterRequest();
    const connection = connect(r);
    await ask(connection, "SELECT 0");
    const asked = enterRequest();
    await new Promise<void>((resolve, reject) =>
      connection.query("SELECT 1", (err: unknown) => {
        if (err) return reject(err);
        expect(currentContext()).toBe(asked);
        connection.query("SELECT 2", (again: unknown) => (again ? reject(again) : resolve()));
      }),
    );
    expect(work(asked, r.target)?.calls).toBe(2);
    expect(work(opened, r.target)?.calls).toBe(1);
  });

  it("gives the query a pool runs after a wait to the request that waited, and times the wait", async () => {
    const r = await rig((sql) => (/SLOW/.test(sql) ? { delayMs: 150 } : {}));
    const db = pool(r, { connectionLimit: 1 });
    await ask(db, "SELECT 0"); // the one connection, opened outside any request
    const first = enterRequest();
    const holding = ask(db, "SELECT 1 AS SLOW");
    const second = enterRequest();
    const waiting = ask(db, "SELECT 2");
    await Promise.all([holding, waiting]);
    expect(queriesOf(first)).toEqual(["SELECT ? AS SLOW"]);
    expect(queriesOf(second)).toEqual(["SELECT ?"]);
    expect(work(second, r.target)?.waitMs).toBeGreaterThan(100);
  });

  it("counts a query run with no callback when it is issued, as `mysql2`'s event form", async () => {
    const r = await rig();
    const connection = connect(r);
    const ctx = enterRequest();
    const query = connection.query("SELECT 1");
    await once(query, "end");
    expect(work(ctx, r.target)).toMatchObject({ calls: 1, errors: 0 });
  });

  it("does not count work outside a request, and does not look at its text", async () => {
    const r = await rig();
    await ask(pool(r), "SELECT 1");
    expect(r.fingerprints.size).toBe(0);
  });
});

describe("a query through mysqljs that fails", () => {
  it("is a failed call and a failed operation, with a signature that carries no value", async () => {
    const r = await rig(() => ({
      error: { code: 1062, message: "Duplicate entry 'ana@cliente.com' for key 'email'" },
    }));
    const db = pool(r);
    const ctx = enterRequest();
    const { err } = await ask(db, "INSERT INTO users (email) VALUES (?)", ["ana@cliente.com"]);
    expect((err as { code?: unknown }).code).toBe("ER_DUP_ENTRY");
    expect(work(ctx, r.target)).toMatchObject({ calls: 1, errors: 1 });
    const signatures = [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "error");
    expect(signatures).toHaveLength(1);
    expect(JSON.stringify(signatures)).not.toContain("ana@cliente.com");
  });
});

describe("mysqljs sees what it sees without the observer", () => {
  it("gives the same rows, the same error and the same wire", async () => {
    const seen = async (instrumented: boolean) => {
      const r = await rig((sql) => (/boom/.test(sql) ? { error: { code: 1064, message: "no" } } : {}), {
        instrumented,
      });
      const db = pool(r);
      enterRequest();
      const ok = await ask(db, "SELECT ? AS one", [1]);
      const failed = await ask(db, "boom");
      const err = failed.err as { code?: unknown; message?: unknown };
      return { ok: JSON.stringify(ok.rows), failed: { code: err.code, message: err.message }, wire: r.server.received };
    };
    const bare = await seen(false);
    expect(await seen(true)).toEqual(bare);
  });
});

describe("armMysqljs, the start-up half", () => {
  const src = fileURLToPath(new URL("../src/instrument/mysql.ts", import.meta.url));
  async function application(installed: boolean): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "downtrace-armmysqljs-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    if (installed) await symlink(MYSQLJS_ROOT, path.join(dir, "node_modules", "mysql"), "dir");
    const entry = path.join(dir, "app.cjs");
    await writeFile(entry, "");
    return entry;
  }
  async function runAlone(script: string, entry: string): Promise<string[]> {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, entry], {
      env: { ...process.env, NODE_PATH: "" },
    });
    let out = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (c: Buffer) => {
        out += c.toString();
      });
    }
    const code = await new Promise<number>((resolve) => child.on("exit", resolve));
    expect(code, out).toBe(0);
    return out.trim().split("\n");
  }
  const preamble = `
    import { createRequire } from "node:module";
    import path from "node:path";
    import { armMysqljs } from ${JSON.stringify(src)};
    const armed = armMysqljs({
      log: { warn: () => {}, debug: () => {} },
      internalError: (err) => { console.error(String(err)); process.exit(2); },
      from: process.argv[1],
    });
    const require = createRequire(process.argv[1]);
    const lib = path.join(path.dirname(require.resolve("mysql")), "lib");
    const patched = () =>
      Object.getOwnPropertySymbols(require(path.join(lib, "Connection.js")).prototype).length > 0 &&
      Object.getOwnPropertySymbols(require(path.join(lib, "Pool.js")).prototype).length > 0;
  `;

  it("resolves the driver without loading it, and patches its classes once the application has", async () => {
    const entry = await application(true);
    const lines = await runAlone(
      `${preamble}
      console.log(armed.state);
      console.log(Object.keys(require.cache).some((key) => key.includes("mysql" + path.sep + "lib")) ? "loaded" : "not loaded");
      console.log(armed.attach());
      const mysql = require("mysql");
      mysql.createPool({ host: "127.0.0.1" });
      console.log(armed.attach());
      console.log(patched() ? "patched" : "not patched");`,
      entry,
    );
    expect(lines).toEqual(["on", "not loaded", "false", "true", "patched"]);
  });

  it("is unavailable when the application has no mysql, and its attach settles at once", async () => {
    const entry = await application(false);
    const lines = await runAlone(
      `${preamble.replace(/const lib = .*\n/, "").replace(/const patched = [\s\S]*$/, "")}
      console.log(armed.state);
      console.log(armed.attach());`,
      entry,
    );
    expect(lines).toEqual(["unavailable", "true"]);
  });
});
