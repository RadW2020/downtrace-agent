import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import Fastify from "fastify";
import Fastify4 from "fastify4";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { declaredRoutesOf } from "../src/routes.ts";
import { testConfig } from "./support/agent-config.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
ajv.addKeyword("x-error");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

/** In-process stand-in for the cloud: captures the batches it is POSTed. */
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
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, batches, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function config(url: string): AgentConfig {
  return testConfig(url, { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set() });
}

async function hit(url: string, path: string, method = "GET"): Promise<number> {
  const res = await fetch(url + path, { method });
  await res.arrayBuffer();
  return res.status;
}

function routesOf(batch: AggregatesBatch | undefined): Record<string, number> {
  const byRoute: Record<string, number> = {};
  for (const interval of (batch?.intervals ?? []) as Interval[]) {
    for (const e of interval.endpoints)
      byRoute[`${e.method} ${e.route}`] = (byRoute[`${e.method} ${e.route}`] ?? 0) + e.count;
  }
  return byRoute;
}

type Factory = typeof Fastify;

/**
 * Fastify used to be named by the heuristic over the path: `/users/42` came out as `/users/:id` by luck of the
 * digits, `/users/ana` as itself, so every user was a route of its own and its name travelled, and a 404 sent its
 * words. Fastify says which route answered, and the instrumentation asks it.
 *
 * Real Fastify 5 and 4, real agent, real batch. The agent starts **before** the application is built, as
 * `--import` starts it: Fastify announces each instance as it is created (`fastify.initialization`), and that
 * announcement is what the instrumentation hooks into.
 */
describe.each([
  ["Fastify 5", Fastify],
  ["Fastify 4", Fastify4 as unknown as Factory],
])("a %s application is named by its templates", (_name, factory) => {
  async function serve() {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const app = factory();
    app.get("/users/:id", async () => ({ ok: true }));
    app.route({ method: ["PUT", "PATCH"], url: "/items/:id", handler: async () => "item" });
    app.all("/any", async () => "any");
    await app.register(
      async (api) => {
        api.post("/orders", async () => "order");
        await api.register(
          async (tenant) => {
            tenant.get("/invoices/:invoice", async () => "invoice");
          },
          { prefix: "/tenants/:tenant" },
        );
      },
      { prefix: "/api" },
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    cleanups.push(
      sink.close,
      () => agent.stop(),
      () => app.close(),
    );
    return { url, agent, sink, app };
  }

  it("names each request by the route that answered it, prefixes included, and none of its values travel", async () => {
    const { url, agent, sink } = await serve();
    expect(await hit(url, "/users/ana")).toBe(200);
    expect(await hit(url, "/users/42")).toBe(200);
    expect(await hit(url, "/items/9", "PATCH")).toBe(200);
    expect(await hit(url, "/api/orders", "POST")).toBe(200);
    expect(await hit(url, "/api/tenants/acme/invoices/inv-7")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    expect(routesOf(batch)).toEqual({
      "GET /users/:id": 2,
      "PATCH /items/:id": 1,
      "POST /api/orders": 1,
      "GET /api/tenants/:tenant/invoices/:invoice": 1,
    });
    const body = JSON.stringify(batch);
    for (const word of ["ana", "acme", "inv-7"]) expect(body, `«${word}» does not leave`).not.toContain(word);
  });

  it("names a request no route matched (unmatched), and nothing of its path travels (DT-56)", async () => {
    const { url, agent, sink } = await serve();
    expect(await hit(url, "/webhook/plainsecret")).toBe(404);
    expect(await hit(url, "/users/7", "DELETE")).toBe(404);
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(routesOf(batch)).toEqual({ "GET (unmatched)": 1, "DELETE (unmatched)": 1 });
    expect(JSON.stringify(batch)).not.toContain("plainsecret");
  });

  it("declares its routes for check: one name per method, as a request gets it, and none for HEAD or all", async () => {
    const { app } = await serve();
    expect(declaredRoutesOf(app).sort()).toEqual([
      "GET /api/tenants/:tenant/invoices/:invoice",
      "GET /users/:id",
      "PATCH /items/:id",
      "POST /api/orders",
      "PUT /items/:id",
    ]);
  });
});
