import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { MongoClient } from "mongodb";
import mongoose from "mongoose";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { Logger } from "../src/log.ts";
import { testConfig } from "./support/agent-config.ts";
import { startMongoWire } from "./support/mongo-wire.mjs";

/**
 * MongoDB through the agent as an application meets it (ADR 0237): an Express app on the official driver, or on
 * Mongoose, the real start — which resolves the driver and loads nothing, and patches it at the first request — a few
 * requests, and the batch that leaves, against the schema the cloud validates with.
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

type Lookup = (email: string) => Promise<unknown>;

/** The tests' own MongoDB, for as long as the test runs. */
async function ownServer(): Promise<string> {
  const wire = await startMongoWire();
  cleanups.push(() => wire.close());
  return wire.url;
}

/** An Express app whose route looks a user up twice and writes one order, through `lookup` and `place`. */
async function startShop(
  connect: (url: string) => Promise<{ lookup: Lookup; place: Lookup; close: () => Promise<unknown> }>,
  database: string | undefined,
) {
  const sink = await startSink();
  const url = database ?? (await ownServer());
  const agent = createAgent(
    testConfig(sink.url, { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set(["mongodb"]) }),
    { log: quiet },
  );
  agent.start();
  cleanups.push(() => agent.stop());
  // At start-up, as an application connects: the driver's handshake belongs to no request.
  const db = await connect(url);
  cleanups.push(() => db.close());
  const app = express();
  app.get("/users/:email", async (req, res) => {
    await db.lookup(req.params.email);
    await db.lookup(req.params.email);
    await db.place(req.params.email);
    res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { agent, sink, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const hit = async (url: string, path: string): Promise<number> => {
  const res = await fetch(url + path);
  await res.arrayBuffer();
  return res.status;
};

const CONNECTIONS = {
  "the official driver": async (url: string) => {
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    const db = client.db();
    return {
      lookup: (email: string) => db.collection("users").findOne({ email }),
      place: (email: string) => db.collection("orders").insertOne({ email }),
      close: () => client.close(),
    };
  },
  Mongoose: async (url: string) => {
    const connection = await mongoose.createConnection(url, { serverSelectionTimeoutMS: 2000 }).asPromise();
    const User = connection.model("User", new mongoose.Schema({ email: String }), "users");
    const Order = connection.model("Order", new mongoose.Schema({ email: String }), "orders");
    return {
      lookup: (email: string) => User.findOne({ email }).lean(),
      place: (email: string) => Order.create({ email }),
      close: () => connection.close(),
    };
  },
};

/** A real MongoDB, when one is given (`MONGODB_URL`), beside the tests' own server, which is always there. */
const SERVERS = [
  ["the tests' own server", undefined],
  ...(process.env.MONGODB_URL ? [["MongoDB at MONGODB_URL", process.env.MONGODB_URL] as const] : []),
] as const;

describe.each(
  SERVERS.flatMap(([where, server]) =>
    Object.entries(CONNECTIONS).map(([how, connect]) => [`${how}, ${where}`, connect, server] as const),
  ),
)("an Express app on MongoDB, through %s", (_name, connect, server) => {
  it("reports its commands as operations of the route, by command and collection, and the database once", async () => {
    const shop = await startShop(connect, server);
    for (const email of ["ana@example.com", "bea@example.com", "eva@example.com"]) {
      expect(await hit(shop.url, `/users/${email}`)).toBe(200);
    }
    await shop.agent.stop(); // leaving closes the profile's window, which is how a short test sees it

    const batches = shop.sink.batches;
    for (const batch of batches) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    const endpoint = batches.find((b) => b.profile)?.profile?.endpoints.find((e) => e.route === "/users/:email");
    expect(endpoint?.operations.map((o) => [o.kind, o.text, o.count, o.errors ?? 0]).sort()).toEqual(
      [
        ["query", "find users", 6, 0],
        ["query", "insert orders", 3, 0],
      ].sort(),
    );
    const interval = batches
      .flatMap((b) => b.intervals)
      .find((i) => i.endpoints.some((e) => e.route === "/users/:email"));
    const dependencies = interval?.endpoints.find((e) => e.route === "/users/:email")?.dependencies ?? [];
    expect(dependencies.map((d) => [d.kind, d.target])).toEqual([["mongodb", ""]]);
    // Three commands in each of three requests: the histogram counts requests by how many calls they made.
    expect(dependencies[0]?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(3);
    expect(JSON.stringify(batches)).not.toContain("example.com");
  });
});
