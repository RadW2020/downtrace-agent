import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express4 from "express4";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { armMounts } from "../src/mounts.ts";
import { testConfig } from "./support/agent-config.ts";
import { express4Root } from "./support/express4-root.ts";

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
 * gh-898. The two failures an Express 4 application paid on every request to a mounted router. The first,
 * while `app.router` was read: in Express 4 it is a getter that throws, the throw escaped into `routeOf`'s
 * guard, the request was never recorded, and the tenth one disabled the instrumentation. The second, behind
 * it: in Express 4 no pattern is recorded — `use` is not on `Router.prototype`, so the fallback read
 * `layer.path`, which is the value the last request matched: a tenant's name in the template (invariant 5),
 * another tenant's under interleaved requests (invariant 7).
 *
 * Real Express 4 (4.22.3, the `express4` devDependency), real agent, real batch, like
 * `mounted-routes.integration.test.ts`. The record is armed the way `Agent.start()` arms it in production —
 * `armMounts` from an application root whose `express` is Express 4 — and the tests say that out loud.
 *
 * The unrecorded case runs first, on purpose: arming is a mark on the shared `Router` and stays for the
 * rest of the process, and a router created before the record was armed is the case that must come out as
 * `:param`.
 */
describe("a mounted router on Express 4 carries its pattern, and the instrumentation stays on (gh-898)", () => {
  it("names a mount whose pattern was not recorded as :param per segment, and never as a value", async () => {
    // Express 4 is not armed in this process yet: the mount registers, and the record does not see it.
    const router = express4.Router();
    router.get("/users/:id", (_req, res) => {
      res.json({});
    });
    const app = express4();
    app.use("/tenants/:tenant", router);
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
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
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    const byRoute = routesOf(batch);
    expect([...byRoute.keys()], "the mount's value is not the pattern").toEqual(["/:param/:param/users/:id"]);
    const body = JSON.stringify(batch);
    expect(body, "the tenant's name does not leave").not.toContain("acme-corp");
  });

  it("records twenty requests on a literal mount, with no internal error and the instrumentation active", async () => {
    const root = await express4Root();
    cleanups.push(root.close);
    // What `Agent.start()` does in production, from an application root whose express is Express 4.
    armMounts(path.join(root.base, "app.js"));
    const router = express4.Router();
    router.get("/users/:id", (req, res) => {
      res.json({ id: req.params.id });
    });
    const app = express4();
    app.use("/api", router);
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    for (let n = 1; n <= 20; n += 1) {
      expect(await hit(url, `/api/users/${n}`)).toBe(200);
    }
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    const byRoute = routesOf(batch);
    expect([...byRoute.keys()], "twenty requests, one route, the mount as it was registered").toEqual([
      "/api/users/:id",
    ]);
    expect(byRoute.get("/api/users/:id")).toBe(20);
    // The read of the app that used to throw counted as an internal error on every request, and the tenth
    // disabled the instrumentation: none of that here, and the requests after the tenth still land. The
    // count also carries the flush's own POST, which the agent observes on the sink's server (invariant 1
    // keeps the sink in-process), so the floor is the point (as in `agent.integration.test.ts`).
    expect(agent.stats.recorded).toBeGreaterThanOrEqual(20);
    expect(agent.stats.internalErrors).toBe(0);
    expect(agent.stats.disabled).toBe(false);
  });

  it("keeps the mount's parameter out of the template for every tenant, interleaved", async () => {
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(path.join(root.base, "app.js"));
    const router = express4.Router();
    router.get("/users/:id", (req, res) => {
      // The slow tenant: it starts first and answers after the other one has, which is the interleaving a
      // read of the layer's per-request state serves up for the slow request (gh-898).
      const done = (): void => {
        res.json({ id: req.params.id });
      };
      if (req.params.id === "42") setTimeout(done, 100);
      else done();
    });
    const app = express4();
    app.use("/tenants/:tenant", router);
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    const slow = hit(url, "/tenants/acme-corp/users/42");
    await new Promise((r) => setTimeout(r, 30)); // the slow one is in flight, asleep in its handler
    await hit(url, "/tenants/otro/users/7"); // the other tenant answers first
    await slow;
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
    expect(body, "neither tenant's name leaves").not.toContain("acme-corp");
    expect(body).not.toContain("otro");
  });

  it("carries nothing of the value for a mount without a path", async () => {
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(path.join(root.base, "app.js"));
    const router = express4.Router();
    router.get("/users/:id", (req, res) => {
      res.json({ id: req.params.id });
    });
    const app = express4();
    app.use(router);
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    expect(await hit(url, "/users/42")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    const byRoute = routesOf(batch);
    expect([...byRoute.keys()], "the pathless mount adds nothing to the template").toEqual(["/users/:id"]);
    expect(JSON.stringify(batch)).not.toContain("/users/42");
  });
});
