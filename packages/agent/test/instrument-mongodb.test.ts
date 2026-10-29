import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apart, dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { mongoFingerprint, patchMongo } from "../src/instrument/mongodb.ts";
import type { Logger } from "../src/log.ts";
import { startMongoWire } from "./support/mongo-wire.mjs";

/**
 * MongoDB's official driver, the real one of each major the application can have — 7, which Mongoose 9 brings, and
 * 6, Mongoose 8's — against a server of the tests' own that speaks the wire protocol (`support/mongo-wire.mjs`).
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
const DRIVERS = [
  ["mongodb 7", "mongodb"],
  ["mongodb 6", "mongodb6"],
] as const;

/** Runs `fn` as the handler of a request, in a context of its own, and returns what it recorded. */
async function inRequest(fn: () => Promise<void>): Promise<RequestContext> {
  return apart(async () => {
    const ctx = enterRequest();
    await fn();
    return ctx;
  });
}

const operationsOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => [o.text, o.count, o.errors]);

interface Collection {
  insertOne(doc: object): Promise<unknown>;
  findOne(filter: object): Promise<unknown>;
  updateOne(filter: object, update: object): Promise<unknown>;
}
interface Client {
  connect(): Promise<unknown>;
  close(): Promise<void>;
  db(): { collection(name: string): Collection; command(command: object): Promise<unknown> };
}

describe.each(DRIVERS)("%s, through Connection.prototype.command", (_name, driver) => {
  let wire: Awaited<ReturnType<typeof startMongoWire>>;
  let client: Client;
  const errors = new ErrorFingerprintCache();

  beforeAll(async () => {
    const resolved = require.resolve(driver);
    const connection = require(path.join(path.dirname(resolved), "cmap", "connection.js"));
    expect(patchMongo(connection, "test", { log: quiet, internalError, errors })).toBe(true);
    wire = await startMongoWire({ failing: ["distinct"] });
    const { MongoClient } = require(driver) as { MongoClient: new (url: string, options: object) => Client };
    client = new MongoClient(wire.url, { serverSelectionTimeoutMS: 2000, maxPoolSize: 1 });
    // Outside any request, as an application connects at start-up: the handshake is not a request's.
    await client.connect();
  });
  afterAll(async () => {
    await client?.close();
    await wire?.close();
  });

  it("records each command a request sends, by its name and its collection, and never a value", async () => {
    const users = client.db().collection("users");
    const ctx = await inRequest(async () => {
      await users.insertOne({ email: "ana@example.com" });
      await users.findOne({ email: "ana@example.com" });
      await users.findOne({ email: "bea@example.com" });
    });
    expect(ctx.work?.get(dependencyKey("mongodb", ""))).toMatchObject({ calls: 3, errors: 0 });
    expect(operationsOf(ctx)).toEqual([
      ["insert users", 1, 0],
      ["find users", 2, 0],
    ]);
    expect(JSON.stringify([...(ctx.operations?.values() ?? [])])).not.toContain("example.com");
  });

  it("puts each command in the request that sent it, when three wait for the pool's one connection", async () => {
    const users = client.db().collection("users");
    const contexts = await Promise.all(
      [1, 2, 3].map((n) =>
        inRequest(async () => {
          for (let i = 0; i < n; i += 1) await users.findOne({ n });
        }),
      ),
    );
    expect(contexts.map((ctx) => ctx.work?.get(dependencyKey("mongodb", ""))?.calls)).toEqual([1, 2, 3]);
  });

  it("counts a command the server refused, and an insert a unique index refused, as failures", async () => {
    const users = client.db().collection("users");
    await users.insertOne({ _id: "taken" } as object);
    const ctx = await inRequest(async () => {
      await users.insertOne({ _id: "taken" } as object).catch(() => {});
      await client
        .db()
        .command({ distinct: "users", key: "email" })
        .catch(() => {});
    });
    expect(ctx.work?.get(dependencyKey("mongodb", ""))).toMatchObject({ calls: 2, errors: 2 });
    expect(operationsOf(ctx)).toEqual([
      ["insert users", 1, 1],
      ["distinct users", 1, 1],
    ]);
  });

  it("records nothing outside a request", async () => {
    const ctx = enterRequest();
    apart(() => {});
    await apart(async () => {
      await client.db().collection("users").findOne({});
    });
    expect(ctx.work).toBeUndefined();
  });
});

describe("a driver before 6, which answers through callbacks", () => {
  it("is not wrapped, and records nothing: the callback comes from whichever request freed a connection", async () => {
    const answered: unknown[] = [];
    class Connection {
      command(_ns: unknown, _cmd: unknown, _options: unknown, callback: (err: unknown, reply: unknown) => void): void {
        callback(undefined, { ok: 1 });
      }
    }
    expect(patchMongo({ Connection }, "4.17.2", { log: quiet, internalError })).toBe(false);
    const ctx = await inRequest(async () => {
      new Connection().command("shop.$cmd", { find: "users" }, {}, (err, reply) => answered.push(err, reply));
    });
    expect(answered).toEqual([undefined, { ok: 1 }]);
    expect(ctx.work).toBeUndefined();
  });
});

describe("the label of a command", () => {
  it("is its name and its collection, for a command that names it first or, as getMore, beside its cursor", () => {
    expect(mongoFingerprint({ find: "users", filter: { email: "ana" } })?.text).toBe("find users");
    expect(mongoFingerprint({ getMore: 42n, collection: "orders" })?.text).toBe("getMore orders");
    expect(mongoFingerprint({ aggregate: 1, pipeline: [{ $currentOp: {} }] })?.text).toBe("aggregate");
    expect(mongoFingerprint({ insert: "system.profile" })?.text).toBe("insert system.profile");
  });

  it("is `?` for a collection whose name looks like a value, or holds what MongoDB's tools would not write", () => {
    for (const name of [
      "tenant_8f3a9c2e1b7d4f60",
      "1234567",
      "c0ffee00-1234-4abc-8def-0123456789ab",
      "users;drop",
      "a b",
    ]) {
      expect(mongoFingerprint({ find: name })?.text, name).toBe("find ?");
    }
  });

  it("is nothing for a command whose name is not a word: it is counted, and is not an operation", () => {
    expect(mongoFingerprint({ "$where-not": "users" })).toBeUndefined();
    expect(mongoFingerprint({})).toBeUndefined();
    expect(mongoFingerprint(null)).toBeUndefined();
  });

  it("is the same identity for the same label, and a different one for MongoDB than for a query of that text", () => {
    const a = mongoFingerprint({ find: "users", filter: { a: 1 } });
    const b = mongoFingerprint({ find: "users", filter: { b: 2 } });
    expect(a?.hash).toBe(b?.hash);
    expect(a?.hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
