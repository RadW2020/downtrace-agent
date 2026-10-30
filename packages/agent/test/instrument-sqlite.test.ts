import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { apart, dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { addonStatementOf, patchSqlite } from "../src/instrument/sqlite.ts";
import type { Logger } from "../src/log.ts";

/**
 * SQLite in the process, through the two drivers that run it (ADR 0239): better-sqlite3, the real native one, and
 * libsql, which `@libsql/client` opens a file with. Both on `:memory:`: nothing here needs a server.
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

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): Iterable<unknown>;
}
interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
  transaction(fn: () => void): () => void;
  close(): void;
}
type DatabaseClass = new (file: string) => Database;

/** Runs `fn` as the handler of a request, in a context of its own, and returns what it recorded. */
function inRequest(fn: () => void): RequestContext {
  return apart(() => {
    const ctx = enterRequest();
    fn();
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

function schema(db: Database): void {
  db.exec(`create table "users" ("id" integer primary key, "email" text unique, "lastSeen" text)`);
}

describe("better-sqlite3", () => {
  const Better = require("better-sqlite3") as DatabaseClass;
  let db: Database;
  let early: Statement;

  beforeAll(() => {
    // Outside any request, as an application opens its database and prepares its statements at start-up.
    db = new Better(":memory:");
    schema(db);
    early = db.prepare(`select "id" from "users" where "email" = ?`);
    const resolved = require.resolve("better-sqlite3");
    const statement = addonStatementOf(resolved, require.cache);
    expect(statement, "the addon the driver loaded, found in the module cache").toBeDefined();
    expect(patchSqlite(Better, "test", deps(), statement)).toBe(true);
  });

  it("records each statement a request runs, as SQLite reads it, and never a value", () => {
    const insert = db.prepare(`insert into "users" ("email", "lastSeen") values (?, '2026-10-30')`);
    const ctx = inRequest(() => {
      insert.run("ana@example.com");
      db.prepare(`select * from "users" where "email" = 'bea@example.com'`).get();
      db.prepare(`select * from [users] where [id] in (1, 2, 3)`).all();
    });
    expect(operationsOf(ctx)).toEqual([
      [`insert into "users" ("email", "lastSeen") values (?)`, 1, 0],
      [`select * from "users" where "email" = ?`, 1, 0],
      ["select * from [users] where [id] in (?)", 1, 0],
    ]);
    expect(sqliteWork(ctx)).toMatchObject({ calls: 3, errors: 0 });
    expect(JSON.stringify([...(ctx.operations?.values() ?? [])])).not.toContain("example.com");
  });

  it("records a statement prepared at start-up, before the instrumentation was there", () => {
    const ctx = inRequest(() => {
      early.get("ana@example.com");
      early.get("bea@example.com");
    });
    expect(operationsOf(ctx)).toEqual([[`select "id" from "users" where "email" = ?`, 2, 0]]);
  });

  it("counts a statement that fails, and hands the application its error untouched", () => {
    db.prepare(`insert into "users" ("email") values ('taken@example.com')`).run();
    const insert = db.prepare(`insert into "users" ("email") values (?)`);
    let thrown: unknown;
    const ctx = inRequest(() => {
      try {
        insert.run("taken@example.com");
      } catch (err) {
        thrown = err;
      }
    });
    expect((thrown as { code?: unknown }).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(operationsOf(ctx)).toEqual([[`insert into "users" ("email") values (?)`, 1, 1]]);
    expect(sqliteWork(ctx)).toMatchObject({ calls: 1, errors: 1 });
  });

  it("records an exec as one operation, and a transaction's statements with its own", () => {
    const insert = db.prepare(`insert into "users" ("email") values (?)`);
    const many = db.transaction(() => {
      insert.run("c@example.com");
      insert.run("d@example.com");
    });
    const ctx = inRequest(() => {
      db.exec(`delete from "users" where "email" like '%@old.example'; vacuum`);
      many();
    });
    const texts = operationsOf(ctx).map(([text]) => text);
    expect(texts).toContain(`delete from "users" where "email" like ?; vacuum`);
    expect(operationsOf(ctx)).toContainEqual([`insert into "users" ("email") values (?)`, 2, 0]);
    expect(texts.some((text) => /^begin/i.test(String(text)))).toBe(true);
    expect(texts.some((text) => /^commit/i.test(String(text)))).toBe(true);
  });

  it("counts a statement iterated, once", () => {
    const ctx = inRequest(() => {
      for (const _row of db.prepare(`select "id" from "users"`).iterate()) {
        // the loop reads the rows; the statement ran once
      }
    });
    expect(operationsOf(ctx)).toEqual([[`select "id" from "users"`, 1, 0]]);
  });

  it("records nothing outside a request, and changes no answer", () => {
    expect(db.prepare("select 41 + 1 as answer").get()).toEqual({ answer: 42 });
    const ctx = inRequest(() => {
      expect(db.prepare("select 41 + 1 as answer").get()).toEqual({ answer: 42 });
    });
    expect(operationsOf(ctx)).toEqual([["select ? + ? as answer", 1, 0]]);
  });

  it("patches once, however often it is asked", () => {
    expect(patchSqlite(Better, "test", deps())).toBe(true);
    const ctx = inRequest(() => {
      db.prepare("select 1").get();
    });
    expect(sqliteWork(ctx)).toMatchObject({ calls: 1 });
  });
});

describe("libsql, and @libsql/client on a file", () => {
  // The copy `@libsql/client` brings, which is the one its queries go through.
  const fromClient = createRequire(require.resolve("@libsql/client"));
  const Libsql = fromClient("libsql") as DatabaseClass;
  let before: Database;
  let unseen: Statement;

  beforeAll(() => {
    // Prepared before the patch: libsql keeps no text of its own, so there is nothing to name this one by.
    before = new Libsql(":memory:");
    unseen = before.prepare("select 1");
    expect(patchSqlite(Libsql, "test", deps())).toBe(true);
  });

  it("records the statements a request prepares and runs", () => {
    const db = new Libsql(":memory:");
    schema(db);
    const ctx = inRequest(() => {
      db.prepare(`insert into "users" ("email") values (?)`).run("ana@example.com");
      db.prepare(`select * from "users" where "email" = ?`).get("ana@example.com");
      db.exec(`update "users" set "lastSeen" = '2026-10-30'`);
    });
    expect(operationsOf(ctx)).toEqual([
      [`insert into "users" ("email") values (?)`, 1, 0],
      [`select * from "users" where "email" = ?`, 1, 0],
      [`update "users" set "lastSeen" = ?`, 1, 0],
    ]);
    db.close();
  });

  it("counts a statement it did not see prepared against the database, and names nothing", () => {
    // Any statement prepared since puts the wrapper on the class every statement shares.
    before.prepare("select 2");
    const ctx = inRequest(() => {
      unseen.get();
    });
    expect(sqliteWork(ctx)).toMatchObject({ calls: 1 });
    expect(operationsOf(ctx)).toEqual([]);
  });

  it("records what @libsql/client runs on a file", async () => {
    const { createClient } = fromClient("@libsql/client") as {
      createClient(config: { url: string }): {
        execute(sql: string | { sql: string; args: unknown[] }): Promise<unknown>;
        close(): void;
      };
    };
    const client = createClient({ url: ":memory:" });
    await client.execute(`create table "events" ("id" integer primary key, "name" text)`);
    const ctx = await apart(async () => {
      const inside = enterRequest();
      await client.execute({ sql: `insert into "events" ("name") values (?)`, args: ["signup"] });
      await client.execute(`select count(*) from "events" where "name" = 'signup'`);
      return inside;
    });
    expect(operationsOf(ctx)).toEqual([
      [`insert into "events" ("name") values (?)`, 1, 0],
      [`select count(*) from "events" where "name" = ?`, 1, 0],
    ]);
    client.close();
  });
});

describe("what is not a SQLite driver", () => {
  it("is not patched, and says so", () => {
    const said: string[] = [];
    const log: Logger = { warn: () => {}, debug: (message) => said.push(message) };
    expect(patchSqlite({}, "test", { ...deps(), log })).toBe(false);
    expect(patchSqlite(class {}, "test", { ...deps(), log })).toBe(false);
    expect(said.length).toBe(2);
  });
});
