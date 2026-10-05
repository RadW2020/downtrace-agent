import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Mysql2 from "mysql2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentContext,
  dependencyKey,
  enterRequest,
  poolWaitOf,
  type RequestContext,
  recordWaitIn,
} from "../src/context.ts";
import { ErrorFingerprintCache, errorFingerprint } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { armMysql, patchMysql } from "../src/instrument/mysql.ts";
import type { Logger } from "../src/log.ts";
import {
  type Driver,
  type FakeMysql,
  freshMysql2,
  freshMysql2Promise,
  type Reply,
  startFakeMysql,
} from "./support/mysql.ts";

/**
 * The `mysql2` observer (DT-91): the real driver, a MySQL server in this process, and the questions the Postgres
 * observer is asked — whose query is it, how long did it wait for a connection, what did it fail with, and what
 * did the application see.
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };

/**
 * What the instrumentation handed to `internalError`, as a failure of its own. A test that is not about one checks
 * this stays empty, so a failure no test asked for is not hidden by being counted instead.
 */
const handed: unknown[] = [];
const deps = {
  log: quiet,
  internalError: (err: unknown): void => {
    handed.push(err);
  },
};
/** What was handed over since the last look, taken, so the `afterEach` sees only what no test asked for. */
const handedOver = (): unknown[] => handed.splice(0);

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  expect(handed.splice(0), "the instrumentation failed while recording").toEqual([]);
  while (cleanups.length) await cleanups.pop()?.();
});

interface Rig {
  mysql: typeof Mysql2;
  server: FakeMysql;
  /** What the dependency is called: the host and the port, and nothing else of the connection. */
  target: string;
  fingerprints: FingerprintCache;
  errors: ErrorFingerprintCache;
}

/**
 * The copy of the driver the tests that follow run against. Every behaviour below is asked of both layouts of
 * `mysql2`: the one before 3.20, where a pooled connection is not a `Connection`, and the one after.
 */
const DRIVERS: ReadonlyArray<readonly [name: string, driver: Driver]> = [
  ["mysql2 3.24, a pooled connection is a Connection", "mysql2"],
  ["mysql2 3.11, a pooled connection is not", "mysql2-legacy"],
];
let using: Driver = "mysql2";

/** A server, its own copy of the driver, and the observer on that copy. */
async function rig(handler?: (sql: string) => Reply, options: { instrumented?: boolean } = {}): Promise<Rig> {
  const server = await startFakeMysql(handler);
  cleanups.push(() => server.close());
  const mysql = freshMysql2(using);
  const fingerprints = new FingerprintCache(1000, "mysql");
  const errors = new ErrorFingerprintCache();
  if (options.instrumented !== false) {
    expect(patchMysql(mysql, "test", { ...deps, fingerprints, errors })).toBe(true);
  }
  return { mysql, server, target: `${server.host}:${server.port}`, fingerprints, errors };
}

/** Credentials and a database that must never be what a dependency is called. */
const SECRET_USER = "dt-user-zq";
const SECRET_PASSWORD = "hunter2-zq";
const SECRET_DATABASE = "payroll-zq";

function connectionOptions(r: Rig, extra: Record<string, unknown> = {}) {
  return {
    host: r.server.host,
    port: r.server.port,
    user: SECRET_USER,
    password: SECRET_PASSWORD,
    database: SECRET_DATABASE,
    ...extra,
  };
}

function connect(r: Rig, extra: Record<string, unknown> = {}): Mysql2.Connection {
  const connection = r.mysql.createConnection(connectionOptions(r, extra));
  cleanups.push(() => connection.destroy());
  return connection;
}

function pool(r: Rig, extra: Record<string, unknown> = {}): Mysql2.Pool {
  const made = r.mysql.createPool(connectionOptions(r, extra));
  cleanups.push(() => new Promise<void>((resolve) => made.end(() => resolve())));
  return made;
}

interface Queryable {
  query: (...args: unknown[]) => unknown;
}

/** One callback query, settled. */
function ask(on: unknown, sql: string, values?: unknown[]): Promise<{ err: unknown; rows: unknown; fields: unknown }> {
  return new Promise((resolve) => {
    const callback = (err: unknown, rows: unknown, fields: unknown) => resolve({ err, rows, fields });
    if (values === undefined) (on as Queryable).query(sql, callback);
    else (on as Queryable).query(sql, values, callback);
  });
}

const mysqlWork = (ctx: RequestContext, target: string) => ctx.work?.get(dependencyKey("mysql", target));
const queriesOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => o.text);

describe.each(DRIVERS)("%s", (_name, driver) => {
  beforeEach(() => {
    using = driver;
  });

  describe("a query through mysql2 counts against the request that asked", () => {
    it("is a call of the dependency `mysql`, named by host and port and by nothing else of the connection", async () => {
      const r = await rig();
      const connection = connect(r);
      const ctx = enterRequest();
      const { err, rows } = await ask(connection, "SELECT 1");
      expect(err).toBeNull();
      expect(rows).toEqual([{ one: 1 }]);

      expect([...(ctx.work?.values() ?? [])]).toHaveLength(1);
      expect(mysqlWork(ctx, r.target)).toMatchObject({ kind: "mysql", target: r.target, calls: 1, errors: 0 });
      // What the connection was configured with is the application's secret, and none of it is a name.
      const serialised = JSON.stringify([...(ctx.work ?? [])]) + JSON.stringify([...(ctx.operations ?? [])]);
      for (const secret of [SECRET_USER, SECRET_PASSWORD, SECRET_DATABASE]) expect(serialised).not.toContain(secret);
    });

    it("is the same through the promise wrapper", async () => {
      const r = await rig();
      const connection = connect(r).promise();
      const ctx = enterRequest();
      const [rows] = await connection.query("SELECT 1");
      expect(rows).toEqual([{ one: 1 }]);
      expect(mysqlWork(ctx, r.target)?.calls).toBe(1);
      expect(queriesOf(ctx)).toEqual(["SELECT ?"]);
    });

    it("is the same through `mysql2/promise` on its own", async () => {
      const r = await rig();
      const promise = freshMysql2Promise(using);
      const connection = await promise.createConnection(connectionOptions(r));
      cleanups.push(() => connection.destroy());
      const ctx = enterRequest();
      await connection.query("SELECT 1");
      expect(mysqlWork(ctx, r.target)?.calls).toBe(1);
    });

    it("makes each distinct query an operation of the route, with its count", async () => {
      const r = await rig();
      const connection = connect(r);
      const ctx = enterRequest();
      await ask(connection, "SELECT id FROM orders WHERE id = 7");
      await ask(connection, "SELECT id FROM orders WHERE id = 8");
      await ask(connection, "SELECT name FROM users");
      await ask(connection, "UPDATE users SET name = 'x'");
      const operations = [...(ctx.operations?.values() ?? [])];
      expect(operations.map((o) => [o.kind, o.text, o.count]).sort()).toEqual(
        [
          ["query", "SELECT id FROM orders WHERE id = ?", 2],
          ["query", "SELECT name FROM users", 1],
          ["query", "UPDATE users SET name = ?", 1],
        ].sort(),
      );
      expect(mysqlWork(ctx, r.target)?.calls).toBe(4);
    });

    it("fingerprints the text the application wrote, and never the values the client puts into it", async () => {
      const r = await rig();
      const connection = connect(r);
      const ctx = enterRequest();
      await ask(connection, 'SELECT * FROM users WHERE email = ? AND name = "ana-zq"', ["zq@cliente.com"]);

      // The wire carries the values (the driver formats them in before it sends), and the fingerprint does not.
      expect(r.server.received[0]).toContain("zq@cliente.com");
      expect(queriesOf(ctx)).toEqual(["SELECT * FROM users WHERE email = ? AND name = ?"]);
      const serialised = JSON.stringify([...(ctx.operations ?? [])]);
      expect(serialised).not.toContain("zq@cliente.com");
      expect(serialised).not.toContain("ana-zq");
      // One text, one entry: the values did not make it two.
      expect(r.fingerprints.size).toBe(1);
    });

    it("leaves the application's own async context as the driver gives it, and changes only its own", async () => {
      // The callback runs in the request's context for the instrumentation's own storage, so a chain of queries
      // belongs to its request. Nothing else the application keeps in async storage moves: it sees in its
      // callback what it sees without the instrumentation, the connection's — not the context of the call.
      const seenWith = async (instrumented: boolean): Promise<string | undefined> => {
        const app = new AsyncLocalStorage<string>();
        const r = await rig(undefined, { instrumented });
        const connection = app.run("opened by the first request", () => connect(r));
        return app.run("asked by the second", () => {
          enterRequest();
          return new Promise((resolve) => connection.query("SELECT 1", () => resolve(app.getStore())));
        });
      };
      const bare = await seenWith(false);
      expect(bare, "what the driver gives").toBe("opened by the first request");
      expect(await seenWith(true)).toBe(bare);
    });

    it("records a text the normaliser does not understand as a class and no label, and the query still runs", async () => {
      const r = await rig();
      const connection = connect(r);
      const ctx = enterRequest();
      const { err } = await ask(connection, "SELECT * FROM `orders WHERE email = 'ana@cliente.com'");
      expect(err).toBeNull(); // the server of this test answers anything; the point is what the observer made of it
      const [operation] = [...(ctx.operations?.values() ?? [])];
      expect(operation).toMatchObject({ kind: "query", text: "", class: "select", count: 1 });
      expect(JSON.stringify(operation)).not.toContain("ana@cliente.com");
      expect(mysqlWork(ctx, r.target)?.calls).toBe(1);
    });

    it("reads the text of an options object, with its values or without", async () => {
      const r = await rig();
      const connection = connect(r);
      const ctx = enterRequest();
      await new Promise((resolve) => connection.query({ sql: "SELECT ? AS one", values: [1] }, resolve));
      await new Promise((resolve) => connection.query({ sql: "SELECT 2 AS two" }, resolve));
      await new Promise((resolve) => connection.query({ sql: "SELECT ? AS three" }, [3], resolve));
      expect(queriesOf(ctx).sort()).toEqual(["SELECT ? AS one", "SELECT ? AS three", "SELECT ? AS two"]);
    });

    it("counts a query that is run with no callback once, when it is issued", async () => {
      // `connection.query(sql)` with listeners is the event form: it settles on events the observer does not
      // listen to, because adding an `error` listener would swallow an error nobody handles. The count is the
      // thing a profile needs; its time and its failure are not observable here (the same as a `pg` cursor).
      const r = await rig();
      const connection = connect(r);
      const ctx = enterRequest();
      const command = connection.query("SELECT 1");
      await once(command as unknown as EventEmitter, "end");
      expect(mysqlWork(ctx, r.target)).toMatchObject({ calls: 1, errors: 0 });
      expect(queriesOf(ctx)).toEqual(["SELECT ?"]);
    });

    it("does not count work outside a request, and does not look at its text", async () => {
      const r = await rig();
      const connection = connect(r);
      expect(currentContext()).toBeUndefined();
      const { err, rows } = await ask(connection, "SELECT 1");
      expect(err).toBeNull();
      expect(rows).toEqual([{ one: 1 }]);
      expect(r.fingerprints.size, "no context, no fingerprint").toBe(0);
    });

    it("counts a query without a profile to build, and then does not look at the text", async () => {
      const server = await startFakeMysql();
      cleanups.push(() => server.close());
      const mysql = freshMysql2(using);
      patchMysql(mysql, "test", deps);
      const connection = mysql.createConnection({ host: server.host, port: server.port, user: "u" });
      cleanups.push(() => connection.destroy());
      const ctx = enterRequest();
      await ask(connection, "SELECT 1");
      expect(mysqlWork(ctx, `${server.host}:${server.port}`)?.calls).toBe(1);
      expect(ctx.operations).toBeUndefined();
    });

    it("is the same query for the application whether it is observed or not", async () => {
      const seen = async (instrumented: boolean) => {
        const r = await rig((sql) => (/boom/.test(sql) ? { error: { code: 1062, message: "no" } } : {}), {
          instrumented,
        });
        const connection = connect(r);
        enterRequest();
        const ok = await ask(connection, "SELECT ? AS one", [1]);
        const failed = await ask(connection, "boom");
        const shape = (e: unknown) => (e instanceof Error ? { ...e, name: e.name, message: e.message } : e);
        // The fields carry closures of the copy of the driver that made them, which no two copies share.
        return { ok: { err: ok.err, rows: ok.rows }, failed: shape(failed.err), wire: r.server.received };
      };
      const bare = await seen(false);
      expect(await seen(true)).toEqual(bare);
    });
  });

  describe("a query that fails", () => {
    const DUPLICATE: Reply = {
      error: { code: 1062, message: "Duplicate entry 'ana@cliente.com' for key 'users.email'" },
    };
    const failing = (sql: string): Reply => (/dup/.test(sql) ? DUPLICATE : {});

    it("reaches the application as the driver built it, and counts as a failed call", async () => {
      const r = await rig(failing);
      const connection = connect(r);
      const ctx = enterRequest();
      const { err } = await ask(connection, "INSERT INTO dup (email) VALUES (?)", ["ana@cliente.com"]);
      expect(err).toMatchObject({ code: "ER_DUP_ENTRY", errno: 1062 });
      expect(mysqlWork(ctx, r.target)).toMatchObject({ calls: 1, errors: 1 });
      const query = [...(ctx.operations?.values() ?? [])].find((o) => o.kind === "query");
      expect(query).toMatchObject({ text: "INSERT INTO dup (email) VALUES (?)", count: 1, errors: 1 });
    });

    it("is an error of the route with what the server said, and not the value the message carried", async () => {
      const r = await rig(failing);
      const connection = connect(r);
      const ctx = enterRequest();
      await ask(connection, "INSERT INTO dup (email) VALUES (?)", ["ana@cliente.com"]);
      const errors = [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.text).toContain("Duplicate entry");
      expect(JSON.stringify(errors)).not.toContain("ana@cliente.com");
      expect(JSON.stringify(errors)).not.toContain("users.email");
    });

    it("does not leak what a syntax error quotes of the query", async () => {
      const r = await rig(() => ({
        error: {
          code: 1064,
          message:
            "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version " +
            "for the right syntax to use near 'zq-secret-token AND email = 'ana@cliente.com'' at line 1",
        },
      }));
      const connection = connect(r);
      const ctx = enterRequest();
      const { err } = await ask(connection, "SELEC 1");
      expect(err).toMatchObject({ code: "ER_PARSE_ERROR" });
      const serialised = JSON.stringify([...(ctx.operations ?? [])]);
      expect(serialised).not.toContain("zq-secret-token");
      expect(serialised).not.toContain("ana@cliente.com");
    });

    it("rejects the promise with the error the server sent", async () => {
      const r = await rig(failing);
      const connection = connect(r).promise();
      const ctx = enterRequest();
      await expect(connection.query("INSERT INTO dup VALUES (1)")).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
      expect(mysqlWork(ctx, r.target)).toMatchObject({ calls: 1, errors: 1 });
    });

    it("is a failed call when the connection is already closed, which the driver reports through the callback", async () => {
      const r = await rig();
      const connection = connect(r);
      await ask(connection, "SELECT 1");
      await new Promise<void>((resolve) => connection.end(() => resolve()));
      const ctx = enterRequest();
      const { err } = await ask(connection, "SELECT 1");
      expect((err as Error).message).toMatch(/closed state/);
      expect(mysqlWork(ctx, r.target)).toMatchObject({ calls: 1, errors: 1 });
    });
  });

  /**
   * gh-89: a query belongs to the request whose code ran it. The driver finishes a query on the connection's
   * socket, in the async context the socket was born in — the request that happened to open the connection — so
   * the context has to be taken when the application asks, and the application's own callback has to run in it.
   */
  describe("a query belongs to the request that asked, and to no other", () => {
    it("is not the request that opened the connection, when another one reuses it", async () => {
      const r = await rig();
      const connections = pool(r, { connectionLimit: 1 });
      const first = enterRequest();
      await ask(connections, "SELECT 1 FROM first");
      const second = enterRequest();
      await ask(connections, "SELECT 1 FROM second");
      await ask(connections, "SELECT 1 FROM second");

      expect(r.server.accepted(), "one connection served both").toBe(1);
      expect(queriesOf(first)).toEqual(["SELECT ? FROM first"]);
      expect(queriesOf(second)).toEqual(["SELECT ? FROM second"]);
      expect(mysqlWork(first, r.target)?.calls).toBe(1);
      expect(mysqlWork(second, r.target)?.calls).toBe(2);
    });

    it("is the request whose callback ran it, when the second query comes from inside the first one's callback", async () => {
      // The shape of the callback API: a query chain with no promise in it. The second query is asked from the
      // connection's context unless the callback runs in the context of the call that gave it.
      const r = await rig((sql) => ({ delayMs: /slow/.test(sql) ? 20 : 0 }));
      const connections = pool(r, { connectionLimit: 1 });
      const request = (name: string, slow: string) => {
        const ctx = enterRequest();
        return new Promise<RequestContext>((resolve) => {
          connections.query(`SELECT 1 FROM ${name}_1 ${slow}`, () => {
            connections.query(`SELECT 1 FROM ${name}_2`, () => {
              connections.query(`SELECT 1 FROM ${name}_3`, () => resolve(ctx));
            });
          });
        });
      };
      // Ten requests on one connection: each is queued behind the others and finishes in the context of whichever
      // request held the connection before it.
      const contexts = await Promise.all(
        Array.from({ length: 10 }, (_, i) => request(`r${i}`, i % 2 === 0 ? "slow" : "")),
      );

      for (const [i, ctx] of contexts.entries()) {
        expect(queriesOf(ctx).sort(), `request ${i}`).toEqual(
          [
            `SELECT ? FROM r${i}_1 ${i % 2 === 0 ? "slow" : ""}`.trim(),
            `SELECT ? FROM r${i}_2`,
            `SELECT ? FROM r${i}_3`,
          ].sort(),
        );
        expect(mysqlWork(ctx, r.target)?.calls, `request ${i}`).toBe(3);
      }
    });

    it("is the request that awaited it, through the promise wrapper and a pool", async () => {
      const r = await rig((sql) => ({ delayMs: /slow/.test(sql) ? 15 : 0 }));
      const connections = pool(r, { connectionLimit: 2 }).promise();
      const request = (name: string) => {
        const ctx = enterRequest();
        return (async () => {
          await connections.query(`SELECT 1 FROM ${name}_1 slow`);
          await connections.query(`SELECT 1 FROM ${name}_2`);
          const connection = await connections.getConnection();
          try {
            await connection.query(`SELECT 1 FROM ${name}_3`);
          } finally {
            connection.release();
          }
          return ctx;
        })();
      };
      const contexts = await Promise.all(Array.from({ length: 8 }, (_, i) => request(`p${i}`)));
      for (const [i, ctx] of contexts.entries()) {
        expect(queriesOf(ctx).sort(), `request ${i}`).toEqual(
          [`SELECT ? FROM p${i}_1 slow`, `SELECT ? FROM p${i}_2`, `SELECT ? FROM p${i}_3`].sort(),
        );
      }
    });

    it("is the request whose callback ran it, on a connection another request opened and gave back", async () => {
      // The direct form: `connection.query(sql, callback)` on a checked-out connection, with no command in
      // between. The connection's socket belongs to the first request, so the callback of the second would run in
      // the first's context, and the query it asks from inside would be the first one's.
      const r = await rig();
      const connections = pool(r, { connectionLimit: 1 });
      const opener = enterRequest();
      await new Promise<void>((resolve) =>
        connections.getConnection((err, connection) => {
          if (err) throw err;
          connection.query("SELECT 1 FROM opened", () => {
            connection.release();
            resolve();
          });
        }),
      );
      const borrower = enterRequest();
      await new Promise<void>((resolve) =>
        connections.getConnection((err, connection) => {
          if (err) throw err;
          connection.query("SELECT 1 FROM borrowed_1", () => {
            connection.query("SELECT 1 FROM borrowed_2", () => {
              connection.release();
              resolve();
            });
          });
        }),
      );
      expect(r.server.accepted()).toBe(1);
      expect(queriesOf(opener)).toEqual(["SELECT ? FROM opened"]);
      expect(queriesOf(borrower).sort()).toEqual(["SELECT ? FROM borrowed_1", "SELECT ? FROM borrowed_2"]);
    });

    it("is the request that asked for the connection, when a query runs on one it checked out", async () => {
      const r = await rig();
      const connections = pool(r, { connectionLimit: 1 });
      const checkout = (name: string) => {
        const ctx = enterRequest();
        return new Promise<RequestContext>((resolve) => {
          connections.getConnection((err, connection) => {
            if (err) throw err;
            connection.query(`SELECT 1 FROM ${name}`, () => {
              connection.release();
              resolve(ctx);
            });
          });
        });
      };
      const contexts = await Promise.all([checkout("one"), checkout("two"), checkout("three")]);
      expect(contexts.map(queriesOf)).toEqual([["SELECT ? FROM one"], ["SELECT ? FROM two"], ["SELECT ? FROM three"]]);
    });
  });

  describe("waiting for a connection", () => {
    it("is the pool's wait, apart from the duration of the query that follows it", async () => {
      const r = await rig((sql) => ({ delayMs: /slow/.test(sql) ? 150 : 0 }));
      const connections = pool(r, { connectionLimit: 1 });
      const holder = enterRequest();
      const first = ask(connections, "SELECT 1 slow");
      const waiter = enterRequest();
      const second = ask(connections, "SELECT 1 fast");
      await Promise.all([first, second]);

      const waited = mysqlWork(waiter, r.target);
      expect(waited?.calls).toBe(1);
      // It could not have got the connection before the holder gave it back, and the holder's query took 150 ms.
      expect(waited?.waitMs).toBeGreaterThanOrEqual(100);
      // And the query itself took what the server took to answer it, with the wait left out of it.
      expect(waited?.ms).toBeLessThan(waited?.waitMs ?? 0);
      expect(
        mysqlWork(holder, r.target)?.waitMs,
        "the holder waited for a connection that did not exist yet",
      ).toBeLessThan(waited?.waitMs ?? 0);
    });

    it("is on the same dependency as the queries that follow it, not on one of its own", async () => {
      const r = await rig();
      const connections = pool(r);
      const ctx = enterRequest();
      await ask(connections, "SELECT 1");
      expect([...(ctx.work?.values() ?? [])]).toHaveLength(1);
      expect(mysqlWork(ctx, r.target)).toMatchObject({ calls: 1 });
      expect(mysqlWork(ctx, r.target)?.waitMs).toBeGreaterThanOrEqual(0);
    });

    it("is counted when the pool gives up, which is the case worth seeing", async () => {
      // A pool that holds one connection and queues one request refuses the third.
      const r = await rig((sql) => ({ delayMs: /slow/.test(sql) ? 80 : 0 }));
      const connections = pool(r, { connectionLimit: 1, queueLimit: 1 });
      enterRequest();
      const held = ask(connections, "SELECT 1 slow");
      enterRequest();
      const queued = ask(connections, "SELECT 1 fast");
      const refused = enterRequest();
      const { err } = await ask(connections, "SELECT 1 refused");
      expect((err as Error).message).toMatch(/Queue limit reached/);
      await Promise.all([held, queued]);

      expect(
        mysqlWork(refused, r.target),
        "it names the pool that refused, though it handed over nothing",
      ).toMatchObject({
        calls: 0,
        target: r.target,
      });
      expect(queriesOf(refused)).toEqual([]);
    });

    it("is counted when the database cannot be reached, on the host and port that were tried", async () => {
      const server = await startFakeMysql();
      const { host, port } = server;
      await server.close();
      const mysql = freshMysql2(using);
      patchMysql(mysql, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
      const connections = mysql.createPool({ host, port, user: SECRET_USER, password: SECRET_PASSWORD });
      cleanups.push(() => new Promise<void>((resolve) => connections.end(() => resolve())));
      const ctx = enterRequest();
      const { err } = await ask(connections, "SELECT 1");
      expect(err).toMatchObject({ code: "ECONNREFUSED" });
      expect(mysqlWork(ctx, `${host}:${port}`)).toMatchObject({ target: `${host}:${port}`, calls: 0 });
      expect(JSON.stringify([...(ctx.work ?? [])])).not.toContain(SECRET_PASSWORD);
    });

    it("is not part of the wait that travels with a capture, which is Postgres's (ADR 0200)", async () => {
      const r = await rig();
      const connections = pool(r);
      const ctx = enterRequest();
      await ask(connections, "SELECT 1");
      expect(mysqlWork(ctx, r.target)?.waitMs).toBeGreaterThanOrEqual(0);
      // The evidence carries one number per request, summed across the pools it asked, and the cloud reads it as
      // the wait of Postgres pools. A MySQL pool's wait is in the dependency's aggregate and not in that sum.
      expect(poolWaitOf(ctx.work)).toBeNaN();
      recordWaitIn(ctx, "postgres", "db:5432", 7);
      expect(poolWaitOf(ctx.work)).toBe(7);
    });

    it("does not count the wait outside a request", async () => {
      const r = await rig();
      const connections = pool(r);
      const { err } = await ask(connections, "SELECT 1");
      expect(err).toBeNull();
    });
  });

  describe("what the operator asked not to be looked at", () => {
    it("leaves neither the queries nor the wait of an excluded database", async () => {
      const r = await rig();
      const connections = pool(r);
      const ctx = enterRequest(undefined, performance.now(), { has: (target) => target === r.target });
      await ask(connections, "SELECT 1");
      expect(ctx.work).toBeUndefined();
      expect(ctx.operations).toBeUndefined();
    });

    it("names the dependency as it was told to, in minimal mode", async () => {
      const r = await rig();
      const connections = pool(r);
      const ctx = enterRequest(undefined, performance.now(), undefined, () => "withheld-zq");
      await ask(connections, "SELECT 1");
      expect([...(ctx.work?.keys() ?? [])]).toEqual([dependencyKey("mysql", "withheld-zq")]);
      expect(JSON.stringify([...(ctx.work ?? [])])).not.toContain(String(r.server.port));
    });
  });
});

/**
 * MySQL puts the value in the message: the duplicate entry, the column and the table, the user it refused, the text
 * it choked on. A failed query is recorded with the signature of what it threw (ERR-01), so each of these has to
 * come out with its values gone — the shapes are the server's own, and the quoting of them is what the message
 * rules read (ADR 0170, ADR 0189).
 */
describe("the messages MySQL writes carry values, and the signature of the error carries none", () => {
  const messages: Array<[message: string, values: string[]]> = [
    ["Access denied for user 'dt-user-zq'@'172.17.0.1' (using password: YES)", ["dt-user-zq", "172.17.0.1"]],
    ["Access denied for user 'dt-user-zq'@'db-prod-7.internal.zq' (using password: NO)", ["dt-user-zq", "db-prod-7"]],
    ["Duplicate entry 'ana@cliente.com' for key 'users.email'", ["ana@cliente.com", "users.email"]],
    ["Duplicate entry 'zq-order-77' for key 'orders.PRIMARY'", ["zq-order-77", "orders.PRIMARY"]],
    ["Table 'payroll_zq.salaries' doesn't exist", ["payroll_zq", "salaries"]],
    ["Unknown column 'secret_col_zq' in 'field list'", ["secret_col_zq"]],
    ["Unknown database 'tenant_acme_zq'", ["acme_zq"]],
    ["Incorrect string value: '\\xF0\\x9F\\x98\\x80' for column 'name' at row 1", ["xF0"]],
    ["Incorrect integer value: 'abc-secret-zq' for column 'id' at row 1", ["abc-secret-zq"]],
    ["Incorrect datetime value: '2026-10-05 25:61:00' for column 'created_at' at row 1", ["2026-10-05", "created_at"]],
    ["Truncated incorrect DOUBLE value: 'ana@cliente.com'", ["ana@cliente.com"]],
    ["Can't connect to MySQL server on 'db-zq.internal' (111)", ["db-zq"]],
    [
      "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'zq-secret-token WHERE email = 'ana@cliente.com'' at line 1",
      ["zq-secret-token", "ana@cliente.com"],
    ],
    [
      "Cannot add or update a child row: a foreign key constraint fails (`payroll_zq`.`orders`, CONSTRAINT `fk_zq` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`))",
      ["payroll_zq", "fk_zq"],
    ],
    [
      "Cannot delete or update a parent row: a foreign key constraint fails (`shop_zq`.`order_items`, CONSTRAINT `fk` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`))",
      ["shop_zq"],
    ],
  ];

  it.each(messages)("%s", (message, values) => {
    const { text } = errorFingerprint(new Error(message));
    for (const value of values) expect(text, `kept ${value}`).not.toContain(value);
  });
});

/** A stand-in for the parts of `mysql2` the real driver does not reach through a server of this kind. */
function stub() {
  const calls: unknown[][] = [];
  const log: string[] = [];
  class Command extends EventEmitter {
    sql: unknown;
    onResult: unknown;
    constructor(sql: unknown, onResult?: unknown) {
      super();
      this.sql = sql;
      this.onResult = onResult;
    }
    // The real Query throws on `.then`; an observer that awaited its result would throw into the application.
    // biome-ignore lint/suspicious/noThenProperty: the stand-in is as thenable as the real command, on purpose
    then(): never {
      throw new Error("a command is not a promise");
    }
  }
  const textOf = (first: unknown): unknown => (typeof first === "string" ? first : (first as { sql?: unknown }).sql);
  /** What `query` and `execute` both do: the driver's two entry points, which do not call each other. */
  function run(args: unknown[]): unknown {
    calls.push(args);
    const last = args.at(-1);
    const first = args[0];
    const failing = String(first instanceof Command ? first.sql : textOf(first)).includes("boom");
    if (first instanceof Command) {
      if (typeof first.onResult === "function") {
        // As the driver calls it: a method of the command.
        setTimeout(
          () =>
            (first.onResult as (e: unknown, r: unknown) => void).call(first, failing ? new Error("failed") : null, []),
          1,
        );
      }
      return first;
    }
    if (typeof last === "function") {
      const done = last as (e: unknown, r: unknown) => void;
      if (String(textOf(first)).includes("sync")) done(null, []);
      else setTimeout(() => done(failing ? new Error("failed") : null, []), 1);
    }
    return new Command(textOf(first));
  }
  class Connection {
    config = { host: "db.internal", port: 3307, user: "u", password: "p", database: "d" };
    query(...args: unknown[]): unknown {
      return run(args);
    }
    execute(...args: unknown[]): unknown {
      return run(args);
    }
  }
  class Pool {
    config = { connectionConfig: { host: "pool.internal", port: 3306 } };
    getConnection(cb: (err: unknown, connection?: unknown) => void): void {
      calls.push([cb]);
      setTimeout(() => cb(null, new Connection()), 15);
    }
  }
  return { module: { Connection, Pool }, Connection, Pool, Command, calls, log };
}

describe("the shapes the driver accepts that a server of this kind does not reach", () => {
  it("counts `execute` as it counts `query`, in every form it takes", async () => {
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable & { execute: (...a: unknown[]) => unknown };
    const ctx = enterRequest();
    await new Promise((resolve) => connection.execute("SELECT * FROM a WHERE id = ?", [1], resolve));
    await new Promise((resolve) => connection.execute({ sql: "SELECT * FROM b WHERE id = ?", values: [1] }, resolve));
    await new Promise((resolve) => connection.execute("SELECT * FROM c", resolve));
    expect(queriesOf(ctx).sort()).toEqual([
      "SELECT * FROM a WHERE id = ?",
      "SELECT * FROM b WHERE id = ?",
      "SELECT * FROM c",
    ]);
    expect(mysqlWork(ctx, "db.internal:3307")?.calls).toBe(3);
  });

  it("settles a command that carries its callback, which is what a pool hands the connection", async () => {
    // `pool.query(sql, cb)` builds the command and gives it to `connection.query(command)`: the callback is the
    // command's `onResult`, and not an argument.
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    const ctx = enterRequest();
    const answered = await new Promise<unknown>((resolve) =>
      connection.query(new s.Command("SELECT * FROM boom WHERE id = ?", (err: unknown) => resolve(err))),
    );
    expect(answered).toBeInstanceOf(Error);
    expect(mysqlWork(ctx, "db.internal:3307")).toMatchObject({ calls: 1, errors: 1 });
    expect(queriesOf(ctx)).toEqual(["SELECT * FROM boom WHERE id = ?"]);
  });

  it("returns the very command the driver returned, and never asks it for a result", () => {
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    enterRequest();
    const command = connection.query("SELECT 1");
    expect(command).toBeInstanceOf(s.Command);
    const given = new s.Command("SELECT 2");
    expect(connection.query(given)).toBe(given);
  });

  it("gives the application's callback the driver's arguments, in the driver's order, once", async () => {
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    enterRequest();
    const seen: unknown[][] = [];
    await new Promise<void>((resolve) =>
      connection.query("SELECT 1", [1], function (this: unknown, ...args: unknown[]) {
        seen.push(args);
        resolve();
      }),
    );
    expect(seen).toEqual([[null, []]]);
    expect(s.calls[0]?.slice(0, 2)).toEqual(["SELECT 1", [1]]);
  });

  it("settles a callback that is called before `query` returns", () => {
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    const ctx = enterRequest();
    let answered = 0;
    connection.query("SELECT 1 sync", () => {
      answered += 1;
    });
    expect(answered).toBe(1);
    expect(mysqlWork(ctx, "db.internal:3307")?.calls).toBe(1);
  });

  it("lets what the driver throws reach the application as it came, and counts nothing", () => {
    const s = stub();
    s.Connection.prototype.query = () => {
      throw new TypeError("Bind parameters must not contain undefined");
    };
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    const ctx = enterRequest();
    expect(() => connection.query("SELECT ?", [undefined], () => {})).toThrow(
      "Bind parameters must not contain undefined",
    );
    expect(ctx.work).toBeUndefined();
  });

  it("lets what the application's callback throws reach it once, and not be retried", () => {
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    const ctx = enterRequest();
    let runs = 0;
    expect(() =>
      connection.query("SELECT 1 sync", () => {
        runs += 1;
        throw new Error("the application's bug");
      }),
    ).toThrow("the application's bug");
    expect(runs).toBe(1);
    expect(
      s.calls.filter((c) => c[0] === "SELECT 1 sync"),
      "the driver was asked once",
    ).toHaveLength(1);
    expect(mysqlWork(ctx, "db.internal:3307")?.calls, "and the call was counted").toBe(1);
  });

  it("calls the application's callback as a method of the command, the way the driver does", async () => {
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    enterRequest();
    // Wrapped, because a promise resolved with the command would ask it for a `then`, which the real one refuses.
    const seen = await new Promise<{ receiver: unknown }>((resolve) => {
      const command: unknown = new s.Command("SELECT 1", function (this: unknown) {
        resolve({ receiver: this });
      });
      connection.query(command);
    });
    expect(seen.receiver).toBeInstanceOf(s.Command);
  });
});

describe("a failure while recording never reaches the application", () => {
  it("runs the query, hands the failure over, and does not retry it, when the fingerprint throws", async () => {
    const s = stub();
    const broken = {
      get: () => {
        throw new Error("normaliser failed");
      },
    } as unknown as FingerprintCache;
    patchMysql(s.module, "test", { ...deps, fingerprints: broken });
    const connection = new s.Connection() as unknown as Queryable;
    const ctx = enterRequest();
    await new Promise((resolve) => connection.query("SELECT 1", resolve));
    expect(
      s.calls.filter((c) => c[0] === "SELECT 1"),
      "the driver was asked once",
    ).toHaveLength(1);
    expect(mysqlWork(ctx, "db.internal:3307")?.calls, "the counter was written before the fingerprint failed").toBe(1);
    expect(handedOver().map((e) => (e as Error).message)).toEqual(["normaliser failed"]);
  });

  it("runs the query and hands the failure over when the connection's configuration cannot be read", async () => {
    const s = stub();
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const connection = new s.Connection() as unknown as Queryable;
    Object.defineProperty(connection, "config", {
      get() {
        throw new Error("a getter that throws");
      },
    });
    enterRequest();
    const done = await new Promise((resolve) => connection.query("SELECT 1", (_e: unknown, r: unknown) => resolve(r)));
    expect(done).toEqual([]);
    expect(s.calls.filter((c) => c[0] === "SELECT 1")).toHaveLength(1);
    expect(handedOver().map((e) => (e as Error).message)).toEqual(["a getter that throws"]);
  });

  it("hands the failure over and still gives the application its connection, when the wait cannot be recorded", async () => {
    const s = stub();
    // A pool that hands over a connection which cannot say where it is.
    s.Pool.prototype.getConnection = (cb: (err: unknown, c: unknown) => void) => {
      setTimeout(
        () =>
          cb(null, {
            get config(): never {
              throw new Error("no config");
            },
          }),
        1,
      );
    };
    patchMysql(s.module, "test", { ...deps, fingerprints: new FingerprintCache(100, "mysql") });
    const pool = new s.Pool() as unknown as { getConnection: (cb: (err: unknown, c: unknown) => void) => void };
    enterRequest();
    const connection = await new Promise((resolve) => pool.getConnection((_e, c) => resolve(c)));
    expect(connection).toBeDefined();
    expect(handedOver().map((e) => (e as Error).message)).toEqual(["no config"]);
  });
});

describe("patchMysql", () => {
  it("patches once, however many times it is asked", () => {
    const s = stub();
    patchMysql(s.module, "test", deps);
    const query = s.Connection.prototype.query;
    const getConnection = s.Pool.prototype.getConnection;
    expect(patchMysql(s.module, "test", deps)).toBe(true);
    expect(s.Connection.prototype.query).toBe(query);
    expect(s.Pool.prototype.getConnection).toBe(getConnection);
  });

  it("does nothing when there is nothing it knows how to patch", () => {
    expect(patchMysql({}, "test", deps)).toBe(false);
    expect(patchMysql({ Connection: { prototype: {} } }, "test", deps)).toBe(false);
    expect(patchMysql({ Connection: { prototype: { query: 42 } } }, "test", deps)).toBe(false);
    expect(patchMysql(null, "test", deps)).toBe(false);
    expect(patchMysql("mysql2", "test", deps)).toBe(false);
  });

  it("patches the connection when the pool is not there, and says so", () => {
    const lines: string[] = [];
    const s = stub();
    expect(
      patchMysql({ Connection: s.Connection }, "test", {
        ...deps,
        log: { warn: () => {}, debug: (m) => lines.push(m) },
      }),
    ).toBe(true);
    expect(lines.join("\n")).toContain("Pool.prototype.getConnection");
  });

  it("announces itself once, with the version it patched", () => {
    const lines: string[] = [];
    const s = stub();
    const log = { warn: () => {}, debug: (m: string) => lines.push(m) };
    patchMysql(s.module, "3.99.0", { ...deps, log });
    patchMysql(s.module, "3.99.0", { ...deps, log });
    expect(lines.filter((l) => l.includes("instrumented mysql2 3.99.0"))).toHaveLength(1);
  });
});

/**
 * The deferred attach, as `pg`'s (ADR 0209): the observer resolves `mysql2` from the application's root without
 * loading it, and patches it from the start of the first request at which the application has loaded it. A
 * `node_modules` of its own per test, so the resolution and the module cache are the real ones.
 */
describe("armMysql, the deferred attach", () => {
  const apps: Array<{ cleanup: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.cleanup();
  });

  async function stubApp(indexJs: string) {
    const dir = await mkdtemp(join(tmpdir(), "downtrace-armmysql-"));
    const driver = join(dir, "node_modules", "mysql2");
    await mkdir(driver, { recursive: true });
    await writeFile(
      join(driver, "package.json"),
      JSON.stringify({ name: "mysql2", version: "3.99.0", main: "index.js" }),
    );
    await writeFile(join(driver, "index.js"), indexJs);
    const from = join(dir, "app.js");
    apps.push({ cleanup: () => rm(dir, { recursive: true, force: true }) });
    return { from, appRequire: createRequire(from) };
  }

  const DRIVER = `
    class Connection { query() { return {}; } execute() { return {}; } }
    class Pool { getConnection(cb) { setTimeout(() => cb(null, new Connection()), 1); } }
    module.exports = { Connection, Pool };
  `;
  const MARK = Symbol.for("downtrace.mysql.instrumented");

  it("resolves without loading, so the application's own load is still the first load", async () => {
    const app = await stubApp(DRIVER);
    const armed = armMysql({ ...deps, from: app.from });
    expect(armed.state).toBe("on");
    expect(app.appRequire.cache[app.appRequire.resolve("mysql2")], "the observer loaded nothing").toBeUndefined();
    expect(armed.attach()).toBe(false);
  });

  it("patches at the first request after the application has loaded the driver", async () => {
    const app = await stubApp(DRIVER);
    const lines: string[] = [];
    const armed = armMysql({ ...deps, log: { warn: () => {}, debug: (m) => lines.push(m) }, from: app.from });
    expect(armed.attach()).toBe(false);
    app.appRequire("mysql2");
    expect(armed.attach()).toBe(true);
    const proto = app.appRequire("mysql2").Connection.prototype as Record<PropertyKey, unknown>;
    expect(proto[MARK], "the driver the application loaded is the one patched").toBe(true);
    expect(armed.attach()).toBe(true);
    expect(
      lines.filter((l) => l.includes("instrumented mysql2 3.99.0")),
      "with the version of its package.json",
    ).toHaveLength(1);
  });

  it("settles without patching when the resolved module is not the driver", async () => {
    const app = await stubApp("module.exports = {};");
    const armed = armMysql({ ...deps, from: app.from });
    app.appRequire("mysql2");
    expect(armed.attach()).toBe(true);
    expect(armed.attach()).toBe(true);
    expect(handedOver()).toEqual([]);
  });

  it("says unavailable when the driver cannot be resolved, and its attach settles at once", async () => {
    // The test process resolves `mysql2` from anywhere (its own module paths and NODE_PATH), so the question is
    // asked of a process of its own, with no fallback paths and a root that holds no `node_modules`: the answer
    // an application that does not use mysql2 gets.
    const dir = await mkdtemp(join(tmpdir(), "downtrace-armmysql-"));
    apps.push({ cleanup: () => rm(dir, { recursive: true, force: true }) });
    const src = fileURLToPath(new URL("../src/instrument/mysql.ts", import.meta.url));
    const script = `
      import { armMysql } from ${JSON.stringify(src)};
      const armed = armMysql({
        log: { warn: () => {}, debug: () => {} },
        internalError: (err) => { console.error(String(err)); process.exit(2); },
        from: process.argv[1],
      });
      console.log(armed.state);
      console.log(armed.attach());
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, join(dir, "app.js")], {
      env: { ...process.env, NODE_PATH: "" },
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    const code = await new Promise<number>((resolve) => child.on("exit", resolve));
    expect(code, stdout).toBe(0);
    expect(stdout.trim().split("\n")).toEqual(["unavailable", "true"]);
  });
});
