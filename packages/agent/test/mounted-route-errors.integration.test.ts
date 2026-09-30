import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { expressErrorHandler } from "../src/report.ts";
import { testConfig } from "./support/agent-config.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
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

async function hit(url: string, path: string): Promise<number> {
  const res = await fetch(url + path);
  await res.arrayBuffer();
  return res.status;
}

function routesOf(batch: AggregatesBatch | undefined): Map<string, number> {
  const byRoute = new Map<string, number>();
  for (const interval of (batch?.intervals ?? []) as Interval[]) {
    for (const e of interval.endpoints) byRoute.set(e.route, (byRoute.get(e.route) ?? 0) + e.count);
  }
  return byRoute;
}

function endpointOf(batch: AggregatesBatch | undefined, route: string) {
  for (const interval of (batch?.intervals ?? []) as Interval[]) {
    const endpoint = interval.endpoints.find((e) => e.route === route);
    if (endpoint !== undefined) return endpoint;
  }
  return undefined;
}

/**
 * gh-900. When a mounted route's handler throws, the error leaves the router before the app's error handler
 * answers, and the router has already restored `req.baseUrl`. The route is still the mounted route; the
 * failure has to count where its successes do.
 */
describe("a mounted router's failed request keeps its mount (gh-900)", () => {
  it("counts a 500 answered by the app in the mounted route, next to its 200s", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ ok: true });
    });
    const app = express();
    app.use("/api", router);
    app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).end();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/api/orders/1")).toBe(200);
    expect(await hit(url, "/api/orders/bad")).toBe(500);
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    const byRoute = routesOf(batch);
    expect([...byRoute.keys()], "both responses count in the mounted route, and nowhere else").toEqual([
      "/api/orders/:id",
    ]);
    expect(byRoute.get("/api/orders/:id")).toBe(2);
  });

  it("keeps two mounts of the same router separate when one of them fails", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ id: req.params.id });
    });
    const app = express();
    app.use("/api", router);
    app.use("/tenants/:tenant", router);
    app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).end();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/api/orders/1")).toBe(200);
    expect(await hit(url, "/api/orders/bad")).toBe(500);
    expect(await hit(url, "/tenants/acme-corp/orders/2")).toBe(200);
    expect(await hit(url, "/tenants/acme-corp/orders/bad")).toBe(500);
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    const byRoute = routesOf(batch);
    expect([...byRoute.keys()].sort(), "each mount keeps its own route").toEqual([
      "/api/orders/:id",
      "/tenants/:tenant/orders/:id",
    ]);
    expect(byRoute.get("/api/orders/:id")).toBe(2);
    expect(byRoute.get("/tenants/:tenant/orders/:id")).toBe(2);
    expect(JSON.stringify(batch)).not.toContain("acme-corp");
  });

  it("keeps the mount of a route that lives in a sub-app and fails there", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const v1 = express();
    v1.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ id: req.params.id });
    });
    const app = express();
    app.use("/v1", v1);
    app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).end();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/v1/orders/1")).toBe(200);
    expect(await hit(url, "/v1/orders/bad")).toBe(500);
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    const byRoute = routesOf(batch);
    expect([...byRoute.keys()], "the sub-app's route keeps the parent's mount").toEqual(["/v1/orders/:id"]);
    expect(byRoute.get("/v1/orders/:id")).toBe(2);
  });

  it("does not observe a matched route the operator excluded", async () => {
    const sink = await startSink();
    const agent = createAgent(
      testConfig(sink.url, {
        environment: "test",
        version: "t1",
        intervalMs: 60_000,
        instrument: new Set(),
        excludeEndpoints: ["/api/orders/:id"],
      }),
      { log: quiet },
    );
    agent.start();
    const router = express.Router();
    router.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ id: req.params.id });
    });
    const app = express();
    app.use("/api", router);
    app.use(expressErrorHandler());
    app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).end();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/api/orders/1")).toBe(200);
    expect(await hit(url, "/api/orders/bad")).toBe(500);
    await agent.flushNow();

    for (const batch of sink.batches) {
      expect(routesOf(batch).has("/api/orders/:id")).toBe(false);
      expect(JSON.stringify(batch)).not.toContain("bad order");
    }
  });

  it("counts the route of a 404 answered after its handler called next()", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.get("/orders/:id", (_req, _res, next) => {
      next();
    });
    const app = express();
    app.use("/api", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/api/orders/1")).toBe(404);
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    const byRoute = routesOf(batch);
    expect([...byRoute.keys()]).toEqual(["/api/orders/:id"]);
    expect(byRoute.get("/api/orders/:id")).toBe(1);
    const endpoint = endpointOf(batch, "/api/orders/:id");
    expect(endpoint?.status.clientError).toBe(1);
    expect(endpoint?.status.success).toBe(0);
  });
});
