import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { createClient } from "redis";
import { createClient as createClient5 } from "redis5";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { Logger } from "../src/log.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * node-redis (`redis`, `@redis/client`) against a real Redis: the real driver, the real instrumentation, the real
 * batch. Its commands used to be invisible, because the observer listened only to ioredis's channel; node-redis
 * publishes one of its own from 5.12, with the same shape. Needs `REDIS_URL`, which the gate sets. A disposable one:
 *
 *     docker run --rm -d -p 127.0.0.1:46379:6379 redis:8-alpine
 *     REDIS_URL=redis://127.0.0.1:46379 pnpm --filter @downtrace/agent exec vitest run node-redis.integration
 */
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.warn(
    "[agent] REDIS_URL not set: skipping the real node-redis tests (docker run -p 127.0.0.1:46379:6379 redis:8-alpine, then REDIS_URL=redis://127.0.0.1:46379)",
  );
}

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

/** A key and a value no batch may carry: they are the application's data. */
const KEY = "session:ana@cliente.com";
const VALUE = "hunter2-zq";

type Factory = typeof createClient;

async function startShop(factory: Factory) {
  const sink = await startSink();
  const agent = createAgent(testConfig(sink.url, { instrument: new Set(["redis"]), intervalMs: 60_000 }), {
    log: quiet,
  });
  agent.start();
  cleanups.push(() => agent.stop());
  const client = factory({ url: REDIS_URL ?? "" });
  await client.connect();
  cleanups.push(() => client.close());
  const app = express();
  app.get("/cart/:id", async (req, res) => {
    await client.set(KEY, VALUE);
    await client.get(KEY);
    await client.hGetAll(`cart:${req.params.id}`);
    res.json({ ok: true });
  });
  // A transaction: node-redis does not publish its commands one by one, and it is one command of the route.
  app.get("/checkout", async (_req, res) => {
    await client.multi().incr("stock:a").incr("stock:b").incr("stock:c").exec();
    res.json({ ok: true });
  });
  // A pipeline: node-redis publishes each of its commands, and they are counted as what they are.
  app.get("/prices", async (_req, res) => {
    await client.multi().get("price:a").get("price:b").execAsPipeline();
    res.json({ ok: true });
  });
  app.get("/broken", async (_req, res) => {
    await client.sendCommand(["NOSUCHCOMMAND", VALUE]).catch(() => {});
    res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const { hostname, port } = new URL(REDIS_URL ?? "");
  return {
    agent,
    sink,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    target: `${hostname}:${port}`,
  };
}

const hit = async (url: string, path: string): Promise<number> => {
  const res = await fetch(url + path);
  await res.arrayBuffer();
  return res.status;
};

describe.skipIf(!REDIS_URL).each([
  ["redis 6", createClient],
  ["redis 5", createClient5 as unknown as Factory],
])("an Express app on node-redis (%s)", (_name, factory) => {
  it("reports each command as an operation of the route, by its name and its server, and never its key or value", async () => {
    const shop = await startShop(factory);
    for (let id = 1; id <= 3; id++) expect(await hit(shop.url, `/cart/${id}`)).toBe(200);
    await shop.agent.stop(); // leaving closes the profile's window, which is how a short test sees it

    for (const batch of shop.sink.batches) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    const profile = shop.sink.batches.find((b) => b.profile !== undefined)?.profile;
    const cart = profile?.endpoints.find((e) => e.route === "/cart/:id");
    expect(cart?.operations.map((o) => [o.kind, o.text, o.count, o.errors ?? 0]).sort()).toEqual(
      [
        ["command", `GET ${shop.target}`, 3, 0],
        ["command", `HGETALL ${shop.target}`, 3, 0],
        ["command", `SET ${shop.target}`, 3, 0],
      ].sort(),
    );
    const interval = shop.sink.batches
      .flatMap((b) => b.intervals)
      .find((i) => i.endpoints.some((e) => e.route === "/cart/:id"));
    const dependencies = interval?.endpoints.find((e) => e.route === "/cart/:id")?.dependencies ?? [];
    expect(dependencies.map((d) => [d.kind, d.target])).toEqual([["redis", shop.target]]);
    expect(dependencies[0]?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(3);
    expect(dependencies[0]?.errors).toBe(0);

    const wire = JSON.stringify(shop.sink.batches);
    for (const secret of ["ana@cliente.com", "session:", VALUE])
      expect(wire, `leaked: ${secret}`).not.toContain(secret);
  });

  it("reports a transaction as one MULTI, and a pipeline as the commands it ran", async () => {
    const shop = await startShop(factory);
    expect(await hit(shop.url, "/checkout")).toBe(200);
    expect(await hit(shop.url, "/prices")).toBe(200);
    await shop.agent.stop();

    const endpoints = shop.sink.batches.find((b) => b.profile !== undefined)?.profile?.endpoints ?? [];
    const operationsOf = (route: string) =>
      endpoints.find((e) => e.route === route)?.operations.map((o) => [o.text, o.count]);
    expect(operationsOf("/checkout")).toEqual([[`MULTI ${shop.target}`, 1]]);
    expect(operationsOf("/prices")).toEqual([[`GET ${shop.target}`, 2]]);
  });

  it("counts a command Redis refused as a failed call of the dependency, and nothing of its arguments travels", async () => {
    const shop = await startShop(factory);
    expect(await hit(shop.url, "/broken")).toBe(200);
    await shop.agent.stop();

    for (const batch of shop.sink.batches) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    const interval = shop.sink.batches
      .flatMap((b) => b.intervals)
      .find((i) => i.endpoints.some((e) => e.route === "/broken"));
    const [dependency] = interval?.endpoints.find((e) => e.route === "/broken")?.dependencies ?? [];
    expect(dependency).toMatchObject({ kind: "redis", target: shop.target, errors: 1 });
    expect(JSON.stringify(shop.sink.batches)).not.toContain(VALUE);
  });
});
