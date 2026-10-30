import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apart, dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { patchSqlite3 } from "../src/instrument/sqlite3.ts";
import type { Logger } from "../src/log.ts";

/**
 * SQLite through node-sqlite3, the callback driver Knex and Sequelize open SQLite with: the real driver, 6 and 5, on
 * `:memory:`. Its statements run on a thread of the addon's and answer through a callback, so what is counted is
 * taken from the call, in the request that made it, and finished in the callback.
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };
const handed: unknown[] = [];
const internalError = (err: unknown): void => {
  handed.push(err);
};
afterEach(() => {
  expect(handed.splice(0), "the instrumentation failed while recording").toEqual([]);
});

const require = createRequire(import.meta.url);

type Callback = (this: { lastID?: number; changes?: number }, err: Error | null, result?: unknown) => void;
interface Statement {
  run(...args: unknown[]): Statement;
  all(...args: unknown[]): Statement;
  finalize(callback?: () => void): void;
}
interface Database {
  run(sql: string, ...args: unknown[]): Database;
  get(sql: string, ...args: unknown[]): Database;
  all(sql: string, ...args: unknown[]): Database;
  each(sql: string, ...args: unknown[]): Database;
  exec(sql: string, callback?: (err: Error | null) => void): Database;
  prepare(sql: string, ...args: unknown[]): Statement;
  close(callback?: (err: Error | null) => void): void;
}
interface Driver {
  Database: new (file: string, callback?: (err: Error | null) => void) => Database;
  Statement: { prototype: object };
}

async function inRequest(fn: () => Promise<void>): Promise<RequestContext> {
  return apart(async () => {
    const ctx = enterRequest();
    await fn();
    return ctx;
  });
}

const operationsOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => [o.text, o.count, o.errors]);
const sqliteWork = (ctx: RequestContext) => ctx.work?.get(dependencyKey("sqlite", ""));

function deps() {
  return {
    log: quiet,
    internalError,
    fingerprints: new FingerprintCache(100, "sqlite"),
    errors: new ErrorFingerprintCache(),
  };
}

/** A callback as a promise: what `util.promisify` does, and what Knex does. */
function called(run: (callback: Callback) => void): Promise<{ err: Error | null; result: unknown; self: unknown }> {
  return new Promise((resolve) => {
    run(function (err, result) {
      resolve({ err, result, self: this });
    });
  });
}

describe.each([
  ["sqlite3 6", "sqlite3"],
  ["sqlite3 5", "sqlite3-5"],
])("%s", (_name, driver) => {
  const sqlite3 = require(driver) as Driver;
  let db: Database;
  let early: Statement;

  beforeAll(async () => {
    // Outside any request, as an application opens its database, makes its tables and prepares at start-up.
    db = new sqlite3.Database(":memory:");
    await called((done) => db.exec('create table "users" ("id" integer primary key, "email" text unique)', done));
    await called((done) => db.run('insert into "users" ("email") values (?)', "ana@example.com", done));
    early = db.prepare('select "id" from "users" where "email" = ?');
    expect(patchSqlite3(sqlite3, "test", deps())).toBe(true);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => early.finalize(() => resolve()));
    await new Promise<void>((resolve) => db.close(() => resolve()));
  });

  it("counts each statement a request runs, named by its SQL, and finishes it when its callback is called", async () => {
    const ctx = await inRequest(async () => {
      for (const id of [1, 2, 3]) await called((done) => db.get('select * from "users" where "id" = ?', id, done));
      await called((done) => db.all('select * from "users"', done));
    });
    expect(operationsOf(ctx)).toEqual([
      ['select * from "users" where "id" = ?', 3, 0],
      ['select * from "users"', 1, 0],
    ]);
    expect(sqliteWork(ctx)).toMatchObject({ calls: 4, errors: 0 });
  });

  it("counts a statement prepared at start-up, at each run, by its text", async () => {
    const ctx = await inRequest(async () => {
      await called((done) => early.all("ana@example.com", done));
      await called((done) => early.all("bo@example.com", done));
    });
    expect(operationsOf(ctx)).toEqual([['select "id" from "users" where "email" = ?', 2, 0]]);
  });

  it("hands the callback what the driver hands it, this included", async () => {
    let answer: { err: Error | null; self: unknown } | undefined;
    const ctx = await inRequest(async () => {
      answer = await called((done) => db.run('insert into "users" ("email") values (?)', "bo@example.com", done));
    });
    expect(answer?.err).toBeNull();
    expect((answer?.self as { lastID?: number } | undefined)?.lastID).toBeGreaterThan(1);
    expect(operationsOf(ctx)).toEqual([['insert into "users" ("email") values (?)', 1, 0]]);
  });

  it("records a failed statement, and the application gets the driver's error", async () => {
    let answer: { err: Error | null } | undefined;
    const ctx = await inRequest(async () => {
      answer = await called((done) => db.run('insert into "users" ("email") values (?)', "ana@example.com", done));
    });
    expect((answer?.err as { code?: string } | null)?.code).toBe("SQLITE_CONSTRAINT");
    expect(operationsOf(ctx)).toEqual([['insert into "users" ("email") values (?)', 1, 1]]);
    expect(sqliteWork(ctx)).toMatchObject({ calls: 1, errors: 1 });
  });

  it("records a statement that does not compile, which the driver answers before it runs", async () => {
    let answer: { err: Error | null } | undefined;
    const ctx = await inRequest(async () => {
      answer = await called((done) => db.all("selec * from users", done));
    });
    expect(answer?.err?.message).toContain("syntax error");
    expect(sqliteWork(ctx)).toMatchObject({ calls: 1, errors: 1 });
  });

  it("counts exec, and each with its completion, once each", async () => {
    let rows = 0;
    const ctx = await inRequest(async () => {
      await called((done) => db.exec('update "users" set "email" = "email"', done));
      await new Promise<void>((resolve) =>
        db.each(
          'select * from "users"',
          () => {
            rows += 1;
          },
          () => resolve(),
        ),
      );
    });
    expect(rows).toBeGreaterThan(0);
    expect(operationsOf(ctx)).toEqual([
      ['update "users" set "email" = "email"', 1, 0],
      ['select * from "users"', 1, 0],
    ]);
  });

  it("does not count a statement run with no callback: nothing says when it ends", async () => {
    const ctx = await inRequest(async () => {
      db.run('update "users" set "email" = "email"');
      await called((done) => db.get("select 1", done));
    });
    expect(operationsOf(ctx)).toEqual([["select ?", 1, 0]]);
  });

  it("records nothing outside a request", async () => {
    const ctx = await inRequest(async () => {});
    await called((done) => db.all('select * from "users"', done));
    expect(operationsOf(ctx)).toEqual([]);
  });

  it("patches once, however many times it is asked", async () => {
    expect(patchSqlite3(sqlite3, "test", deps())).toBe(true);
    const ctx = await inRequest(async () => {
      await called((done) => db.get("select 1", done));
    });
    expect(operationsOf(ctx)).toEqual([["select ?", 1, 0]]);
  });
});

describe("Knex on sqlite3", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Knex's types are not what is under test.
  let knex: any;
  beforeAll(async () => {
    const sqlite3 = require("sqlite3") as Driver;
    patchSqlite3(sqlite3, "test", deps());
    knex = require("knex")({ client: "sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    await knex.schema.createTable("users", (table: { increments(name: string): void; string(name: string): void }) => {
      table.increments("id");
      table.string("email");
    });
    await knex("users").insert([{ email: "ana@example.com" }, { email: "bo@example.com" }]);
  });
  afterAll(async () => {
    await knex?.destroy();
  });

  it("sees the lookup a loop runs per item, in the SQL Knex wrote", async () => {
    const ctx = await inRequest(async () => {
      const users = await knex("users").select("id");
      for (const user of users) await knex("users").where({ id: user.id }).first();
    });
    expect(operationsOf(ctx)).toEqual([
      ["select `id` from `users`", 1, 0],
      ["select * from `users` where `id` = ? limit ?", 2, 0],
    ]);
  });
});

describe("what is not a driver", () => {
  it("says there is nothing to patch", () => {
    for (const nothing of [undefined, null, {}, { Statement: {} }, { Statement: class {} }]) {
      expect(patchSqlite3(nothing, "test", deps())).toBe(false);
    }
  });
});
