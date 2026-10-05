import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { Instrument } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { testConfig } from "./support/agent-config.ts";
import { type Driver, freshMysql2, startFakeMysql } from "./support/mysql.ts";

/**
 * MySQL through the agent as an application meets it (DT-91): an Express app with a `mysql2` pool, the real
 * start, a request, and the batch that leaves. What `instrument-mysql.test.ts` checks piece by piece, checked in
 * the one shape the product is sold in, against the schema the cloud validates with.
 */

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const keyword of [
  "x-latency-boundaries-ms",
  "x-calls-per-request-boundaries",
  "x-ingest-path",
  "x-since",
  "x-error",
  "x-evidence-path",
]) {
  ajv.addKeyword(keyword);
}
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** The cloud, in this process: it keeps what it is sent. */
async function startSink() {
  const batches: AggregatesBatch[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === AGGREGATES_PATH) batches.push(JSON.parse(body) as AggregatesBatch);
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, batches };
}

const SECRET_USER = "dt-user-zq";
const SECRET_PASSWORD = "hunter2-zq";
const SECRET_DATABASE = "payroll-zq";

/**
 * An Express app whose route runs three different queries on a `mysql2` pool, through the promise wrapper, the
 * way TypeORM and Sequelize hold it; one of them with a double-quoted value, which in MySQL is a string.
 */
async function startShop(options: {
  instrument: ReadonlySet<Instrument>;
  /** The copy of `mysql2` the application loads: the current one unless a test says otherwise. */
  driver?: Driver;
  extra?: Parameters<typeof testConfig>[1];
  handler?: Parameters<typeof startFakeMysql>[0];
}) {
  const sink = await startSink();
  const database = await startFakeMysql(options.handler);
  cleanups.push(() => database.close());
  const mysql = freshMysql2(options.driver);
  const agent = createAgent(
    testConfig(sink.url, {
      environment: "test",
      version: "t1",
      intervalMs: 60_000,
      instrument: options.instrument,
      ...options.extra,
    }),
    { log: quiet, mysqlModule: mysql },
  );
  agent.start();
  cleanups.push(() => agent.stop());
  const pool = mysql.createPool({
    host: database.host,
    port: database.port,
    user: SECRET_USER,
    password: SECRET_PASSWORD,
    database: SECRET_DATABASE,
    connectionLimit: 2,
  });
  cleanups.push(() => new Promise<void>((resolve) => pool.end(() => resolve())));
  const db = pool.promise();

  const app = express();
  app.get("/orders/:id", async (req, res) => {
    await db.query("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    await db.query("SELECT * FROM order_items WHERE order_id = ?", [req.params.id]);
    await db.query('SELECT * FROM customers WHERE name = "ana-zq" AND email = ?', ["ana@cliente.com"]);
    res.json({ ok: true });
  });
  // A text the normaliser does not understand: a backtick that never closes, with a value behind it.
  app.get("/odd", async (_req, res) => {
    await db.query("SELECT * FROM `orders WHERE email = 'ana@cliente.com' AND name = \"ana-zq\"");
    res.json({ ok: true });
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { agent, sink, database, mysql, url, target: `${database.host}:${database.port}` };
}

const hit = async (url: string, path: string): Promise<number> => {
  const res = await fetch(url + path);
  await res.arrayBuffer();
  return res.status;
};

describe("an Express app with a mysql2 pool", () => {
  // Both layouts of the driver: before 3.20 a pooled connection is not a `Connection`, and a pool is how an
  // application holds it.
  it.each<Driver>(["mysql2", "mysql2-legacy"])(
    "reports three queries as three operations of the route, and the database as host and port (%s)",
    async (driver) => {
      const shop = await startShop({ instrument: new Set(["mysql"]), driver });
      for (let id = 1; id <= 4; id++) expect(await hit(shop.url, `/orders/${id}`)).toBe(200);
      await shop.agent.stop(); // leaving closes the profile's window, which is how a short test sees it

      const batches = shop.sink.batches;
      for (const batch of batches) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
      const profile = batches.find((b) => b.profile !== undefined)?.profile;
      expect(profile, "the profile left with the process").toBeDefined();
      const endpoint = profile?.endpoints.find((e) => e.route === "/orders/:id");
      expect(endpoint?.operations).toHaveLength(3);
      // The queries as the application wrote them, with every value a placeholder, whichever quote wrote it.
      expect(endpoint?.operations.map((o) => [o.kind, o.text, o.count, o.errors ?? 0]).sort()).toEqual(
        [
          ["query", "SELECT * FROM customers WHERE name = ? AND email = ?", 4, 0],
          ["query", "SELECT * FROM order_items WHERE order_id = ?", 4, 0],
          ["query", "SELECT * FROM orders WHERE id = ?", 4, 0],
        ].sort(),
      );
      for (const operation of endpoint?.operations ?? []) expect(operation.totalMs).toBeGreaterThan(0);

      const interval = batches
        .flatMap((b) => b.intervals)
        .find((i) => i.endpoints.some((e) => e.route === "/orders/:id"));
      const orders = interval?.endpoints.find((e) => e.route === "/orders/:id");
      const dependencies = orders?.dependencies ?? [];
      expect(dependencies.map((d) => [d.kind, d.target])).toEqual([["mysql", shop.target]]);
      // Three calls in each of four requests: the histogram counts requests by how many calls they made.
      expect(dependencies[0]?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(4);
      expect(dependencies[0]?.errors).toBe(0);
      expect(dependencies[0]?.totalMs).toBeGreaterThan(0);
      // The route that never asked the database has none, which is a fact and not a zero.
    },
  );

  it("sends a query the normaliser does not understand as its hash and its class, and nothing of its text", async () => {
    const shop = await startShop({ instrument: new Set(["mysql"]) });
    expect(await hit(shop.url, "/odd")).toBe(200);
    await shop.agent.stop();
    for (const batch of shop.sink.batches) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    const operations = shop.sink.batches.find((b) => b.profile)?.profile?.endpoints[0]?.operations ?? [];
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: "query", class: "select", count: 1 });
    expect(operations[0]).not.toHaveProperty("text");
    expect(operations[0]?.hash).toMatch(/^[0-9a-f]{16}$/);
    const wire = JSON.stringify(shop.sink.batches);
    expect(wire).not.toContain("ana@cliente.com");
    expect(wire).not.toContain("ana-zq");
  });

  it("sends nothing the application configured the connection with, nor any value", async () => {
    const shop = await startShop({ instrument: new Set(["mysql"]) });
    await hit(shop.url, "/orders/4821");
    await shop.agent.stop();
    const wire = JSON.stringify(shop.sink.batches);
    for (const secret of [SECRET_USER, SECRET_PASSWORD, SECRET_DATABASE, "ana-zq", "ana@cliente.com", "4821"]) {
      expect(wire, `leaked: ${secret}`).not.toContain(secret);
    }
    // And the values did go to the database: it is the batch that has none, not the application that sent none.
    expect(shop.database.received.join("\n")).toContain("ana@cliente.com");
  });

  it("says nothing about it in `observers`, which the schema does not let it name", async () => {
    const shop = await startShop({ instrument: new Set(["mysql"]) });
    await hit(shop.url, "/orders/1");
    await shop.agent.stop();
    const batch = shop.sink.batches[0];
    expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    expect(batch?.agent.observers).toEqual({ pg: "off", http: "off", redis: "off", runtime: "off" });
  });

  it("keeps the shape of a profile that was asked to send no text: the hashes, and not the labels", async () => {
    const shop = await startShop({ instrument: new Set(["mysql"]), extra: { queryText: false } });
    await hit(shop.url, "/orders/1");
    await shop.agent.stop();
    const operations = shop.sink.batches.find((b) => b.profile)?.profile?.endpoints[0]?.operations ?? [];
    expect(operations).toHaveLength(3);
    for (const operation of operations) {
      expect(operation.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(operation).not.toHaveProperty("text");
    }
  });

  it("counts a failing query as the dependency's failure and as an error of the route", async () => {
    const shop = await startShop({
      instrument: new Set(["mysql"]),
      handler: (sql) =>
        /order_items/.test(sql)
          ? { error: { code: 1062, message: "Duplicate entry 'ana@cliente.com' for key 'order_items.email'" } }
          : {},
    });
    // The route awaits the rejection and answers 500.
    expect(await hit(shop.url, "/orders/1")).toBe(500);
    await shop.agent.stop();
    for (const batch of shop.sink.batches) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    const interval = shop.sink.batches.flatMap((b) => b.intervals)[0];
    const orders = interval?.endpoints.find((e) => e.route === "/orders/:id");
    expect(orders?.dependencies?.[0]).toMatchObject({ kind: "mysql", target: shop.target, errors: 1 });
    const operations = shop.sink.batches.find((b) => b.profile)?.profile?.endpoints[0]?.operations ?? [];
    expect(operations.find((o) => o.kind === "error")?.text).toContain("Duplicate entry");
    expect(JSON.stringify(shop.sink.batches)).not.toContain("ana@cliente.com");
  });

  it("does not patch mysql2 when the switch is not on", async () => {
    const shop = await startShop({ instrument: new Set(["pg"]) });
    await hit(shop.url, "/orders/1");
    await shop.agent.stop();
    const proto = shop.mysql.Connection.prototype as unknown as Record<PropertyKey, unknown>;
    expect(proto[Symbol.for("downtrace.mysql.instrumented")]).toBeUndefined();
    const dependencies = shop.sink.batches
      .flatMap((b) => b.intervals)
      .flatMap((i) => i.endpoints.flatMap((e) => e.dependencies ?? []));
    expect(dependencies).toEqual([]);
  });
});
