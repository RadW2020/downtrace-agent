import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { AggregatesBatch, Interval } from "@downtrace/protocol";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0 } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { NextFunction, Request, Response } from "express4";
import express4 from "express4";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { armMounts } from "../src/mounts.ts";
import { expressErrorHandler } from "../src/report.ts";
import { testConfig } from "./support/agent-config.ts";
import { express4Root } from "./support/express4-root.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

async function startSink() {
  const batches: AggregatesBatch[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === AGGREGATES_PATH) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        batches.push(JSON.parse(body) as AggregatesBatch);
        res.writeHead(202).end();
      });
    } else {
      res.writeHead(202).end();
    }
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

const errorTo500 = (_err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  res.status(500).end();
};

/**
 * gh-900. The same mounted-route failures as `mounted-route-errors.integration.test.ts`, on Express 4, with
 * the record armed from an application root whose `express` is Express 4 before the routes are created.
 */
describe("a mounted router's failed request keeps its mount on Express 4 (gh-900)", () => {
  it("counts a 500 answered by the app in the mounted route, next to its 200s", async () => {
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(path.join(root.base, "app.js"));
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express4.Router();
    router.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ id: req.params.id });
    });
    const app = express4();
    app.use("/api", router);
    app.use(errorTo500);
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
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(path.join(root.base, "app.js"));
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express4.Router();
    router.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ id: req.params.id });
    });
    const app = express4();
    app.use("/api", router);
    app.use("/tenants/:tenant", router);
    app.use(errorTo500);
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
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(path.join(root.base, "app.js"));
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const v1 = express4();
    v1.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ id: req.params.id });
    });
    const app = express4();
    app.use("/v1", v1);
    app.use(errorTo500);
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
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(path.join(root.base, "app.js"));
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
    const router = express4.Router();
    router.get("/orders/:id", (req, res) => {
      if (req.params.id === "bad") throw new Error("bad order");
      res.json({ id: req.params.id });
    });
    const app = express4();
    app.use("/api", router);
    app.use(expressErrorHandler());
    app.use(errorTo500);
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
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(path.join(root.base, "app.js"));
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express4.Router();
    router.get("/orders/:id", (_req, _res, next) => {
      next();
    });
    const app = express4();
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
