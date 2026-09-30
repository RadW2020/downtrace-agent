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
 * gh-858. A router mounted with a parameter used to leave the parameter's value in the route template:
 * `req.baseUrl` is what the mount matched, not what it was written as. The template is the one everything
 * groups by, so the value travelled in every batch and grew the cardinality with every tenant.
 *
 * Real Express (5.2.1, the package's devDependency), real agent, real batch, like `agent.integration.test.ts`.
 *
 * The agent starts **before** the routes are registered: `start()` is what arms the mount record (gh-903),
 * and a mount registered before the record is armed comes out as `:param`.
 */
describe("a mounted router carries its pattern, not its value (gh-858)", () => {
  it("keeps the mount's parameter out of the template, for every tenant", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.get("/users/:id", (req, res) => {
      res.json({ id: req.params.id });
    });
    const app = express();
    app.use("/tenants/:tenant", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    await hit(url, "/tenants/acme-corp/users/42");
    await hit(url, "/tenants/otro/users/7");
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    const byRoute = routesOf(batch);
    expect([...byRoute.keys()], "one route for both tenants, named by the pattern").toEqual([
      "/tenants/:tenant/users/:id",
    ]);
    expect(byRoute.get("/tenants/:tenant/users/:id")).toBe(2);
    const body = JSON.stringify(batch);
    expect(body, "the tenant's name does not leave").not.toContain("acme-corp");
    expect(body).not.toContain("otro");
  });

  it("keeps a mount without parameters as it was written", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.get("/users/:id", (_req, res) => {
      res.json({});
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

    await hit(url, "/api/users/7");
    expect(await agent.flushNow()).toBe(true);
    expect([...routesOf(sink.batches[0]).keys()]).toEqual(["/api/users/:id"]);
  });

  it("keeps the values of two nested mounts out of the template", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const inner = express.Router();
    inner.get("/users/:id", (_req, res) => {
      res.json({});
    });
    const outer = express.Router();
    outer.use("/teams/:team", inner);
    const app = express();
    app.use("/tenants/:tenant", outer);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    await hit(url, "/tenants/acme-corp/teams/team-7/users/42");
    await hit(url, "/tenants/otro/teams/t-2/users/9");
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    const byRoute = routesOf(batch);
    expect([...byRoute.keys()]).toEqual(["/tenants/:tenant/teams/:team/users/:id"]);
    expect(byRoute.get("/tenants/:tenant/teams/:team/users/:id")).toBe(2);
    const body = JSON.stringify(batch);
    for (const value of ["acme-corp", "team-7", "otro", "t-2", "42", "9"]) {
      expect(body, `«${value}» does not leave`).not.toContain(`"${value}"`);
    }
  });

  it("keeps the mount's parameter out when the handler answers late", async () => {
    // The router restores what it changed when it finishes; a handler that answers is what keeps the mount
    // on the request until the response does. A late answer is the normal case, and it is the one a fix
    // that reads the request too early misses.
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const router = express.Router();
    router.get("/users/:id", async (_req, res) => {
      await new Promise((r) => setTimeout(r, 25));
      res.json({});
    });
    const app = express();
    app.use("/tenants/:tenant", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    await hit(url, "/tenants/acme-corp/users/42");
    expect(await agent.flushNow()).toBe(true);
    expect([...routesOf(sink.batches[0]).keys()]).toEqual(["/tenants/:tenant/users/:id"]);
  });

  it("keeps the mount's parameter out when an app, not a router, is mounted", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const sub = express();
    sub.get("/users/:id", (_req, res) => {
      res.json({});
    });
    const app = express();
    app.use("/orgs/:org", sub);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    await hit(url, "/orgs/acme-corp/users/42");
    await hit(url, "/orgs/otro/users/7");
    expect(await agent.flushNow()).toBe(true);
    const byRoute = routesOf(sink.batches[0]);
    expect([...byRoute.keys()]).toEqual(["/orgs/:org/users/:id"]);
    expect(byRoute.get("/orgs/:org/users/:id")).toBe(2);
  });

  it("keeps the mount's parameter out when an app is mounted under a router", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const sub = express();
    sub.get("/users/:id", (_req, res) => {
      res.json({});
    });
    const outer = express.Router();
    outer.use("/orgs/:org", sub);
    const app = express();
    app.use("/v2", outer);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    await hit(url, "/v2/orgs/acme-corp/users/42");
    await hit(url, "/v2/orgs/otro/users/7");
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    const byRoute = routesOf(batch);
    const body = JSON.stringify(batch);
    // Express does not record the mount path of an app mounted under a router (`parent` and `mountpath`
    // stay unset), so nothing of the prefix can be recovered with confidence and it comes out as `:param`
    // per segment (invariant 5, and what the README says happens). Stable for every tenant, none of it a
    // value.
    expect([...byRoute.keys()]).toEqual(["/:param/:param/:param/users/:id"]);
    expect(byRoute.get("/:param/:param/:param/users/:id")).toBe(2);
    expect(body).not.toContain("acme-corp");
    expect(body).not.toContain("otro");
  });
});
