import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
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

/**
 * gh-766. A router mounted under a prefix that answers from its own middleware — before any route matched —
 * lost the mount's prefix in the route: Express trims `req.url` as the request passes through the mount, and
 * the heuristic read what was left, so `/admin/x` and `/x` landed on the same route, and the 401s of a mounted
 * admin router were attributed to a path that does not exist at the top level.
 *
 * Real Express (5.2.1, the package's devDependency), real agent, real batch, like `agent.integration.test.ts`.
 *
 * The agent starts **before** the routes are registered: `start()` is what arms the mount record (gh-903),
 * and a mount registered before the record is armed comes out as `:param`.
 */
describe("a mounted router's middleware keeps the mount's prefix (gh-766)", () => {
  it("names a middleware's answer by the path the client asked for, and leaves the prefix-less path alone", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.use((_req, res) => {
      res.status(401).json({ error: "unauthorized" });
    });
    const app = express();
    app.use("/admin", router);
    app.get("/x", (_req, res) => {
      res.json({});
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/admin/x")).toBe(401);
    expect(await hit(url, "/x")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    const byRoute = routesOf(batch);
    expect([...byRoute.keys()].sort(), "the two requests are two routes").toEqual(["/admin/x", "/x"]);
    expect(byRoute.get("/admin/x")).toBe(1);
    expect(byRoute.get("/x")).toBe(1);
  });

  it("keeps the prefix of a plain app.use middleware", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const app = express();
    app.use("/static", (_req, res) => {
      res.send("body");
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/static/app.css")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    expect([...routesOf(sink.batches[0]).keys()]).toEqual(["/static/app.css"]);
  });

  it("folds a value in any segment of the path, the prefix and all, and the value does not leave", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.use((_req, res) => {
      res.status(401).json({});
    });
    const app = express();
    app.use("/admin", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/admin/users/ana%40cliente.com/orders")).toBe(401);
    expect(await hit(url, "/admin/reset-password/Zx8kQ2vN4pL9mR7tY3wB")).toBe(401);
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    const byRoute = routesOf(batch);
    expect([...byRoute.keys()].sort()).toEqual(["/admin/reset-password/:id", "/admin/users/:id/orders"]);
    const body = JSON.stringify(batch);
    for (const value of ["ana%40cliente.com", "Zx8kQ2vN4pL9mR7tY3wB"]) {
      expect(body, `«${value}» does not leave`).not.toContain(value);
    }
  });

  it("still lets a matched route win over the heuristic", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.use((req, res, next) => {
      if (req.url === "/secret") {
        res.status(401).json({});
        return;
      }
      next();
    });
    router.get("/items/:id", (req, res) => {
      res.json({ id: req.params.id });
    });
    const app = express();
    app.use("/admin", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/admin/secret")).toBe(401);
    expect(await hit(url, "/admin/items/42")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    const byRoute = routesOf(sink.batches[0]);
    expect(byRoute.get("/admin/secret"), "the middleware's answer, by the path asked for").toBe(1);
    expect(byRoute.get("/admin/items/:id"), "the matched route, by its template").toBe(1);
    expect(byRoute.get("/admin/42")).toBeUndefined();
  });
});
