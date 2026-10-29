import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";
import { serve } from "@hono/node-server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "../src/agent.ts";
import { currentContext } from "../src/context.ts";
import { applicationEntry } from "../src/entry.ts";
import { attachHono, honoRouterOf } from "../src/hono.ts";
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
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** The wrappers are in once the ESM copy's import resolved: the test's `import "hono"` loaded it already. */
async function wrapped(): Promise<void> {
  const proto = RegExpRouter.prototype as unknown as Record<symbol, unknown>;
  await vi.waitFor(() => expect(proto[Symbol.for("downtrace.hono.add")]).toBe(true));
}

function endpointsOf(batch: AggregatesBatch | undefined) {
  return (batch?.intervals ?? []).flatMap((i) => i.endpoints);
}

/**
 * Hono's testing guide calls an application with `app.request()`, which hands Hono a `Request` and never goes through
 * Node's server: Node announces nothing, and a suite written that way was, for `check`, a run that called no route.
 *
 * Real Hono 4, real agent, real batch. The agent starts before the application is built, as `--import` starts it, and
 * wraps Hono's routers before any is given its routes (ADR 0236).
 */
describe("Hono", () => {
  async function started() {
    const sink = await startSink();
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.end("ok");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const agent = createAgent(
      testConfig(sink.url, { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set(["http"]) }),
      { log: quiet },
    );
    agent.start();
    await wrapped();
    cleanups.push(
      sink.close,
      () => new Promise<void>((r) => upstream.close(() => r())),
      () => agent.stop(),
    );
    // As most applications are written: a sub-application under a prefix, behind a middleware of its own.
    const users = new Hono();
    users.use(async (_c, next) => {
      await next();
    });
    users.get("/:userId", async (c) => {
      await (await fetch(`${up}/profile`)).text();
      await (await fetch(`${up}/orders`)).text();
      return c.json({ id: c.req.param("userId") });
    });
    // And one of the application's own, as a logger or CORS is: a request no route matched runs it, and nothing else.
    const app = new Hono();
    app.use(async (_c, next) => {
      await next();
    });
    app.route("/v1/users", users);
    app.post("/v1/refunds", (c) => c.text("refund"));
    return { agent, sink, app, upstream: up.slice("http://".length) };
  }

  it("observes a request made with app.request() by its template and with what it did, apart from the test", async () => {
    const { agent, sink, app, upstream } = await started();
    expect((await app.request("/v1/users/ana")).status).toBe(200);
    expect(currentContext(), "the test that called is not inside the request it made").toBeUndefined();
    expect((await app.request("/v1/users/42")).status).toBe(200);
    // The test's own call after the request is the test's, and belongs to no route.
    await (await fetch(`http://${upstream}/after`)).text();
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    const users = endpointsOf(batch).find((e) => e.route === "/v1/users/:userId");
    expect(users).toMatchObject({ method: "GET", count: 2 });
    const [dependency] = users?.dependencies ?? [];
    expect(dependency).toMatchObject({ kind: "http", target: upstream });
    // Two requests, two calls each: the histogram counts requests by how many calls they made.
    expect(dependency?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(2);
    expect(JSON.stringify(batch)).not.toContain("ana");
  });

  it("names a request no route matched (unmatched), and nothing of its path travels", async () => {
    const { agent, sink, app } = await started();
    expect((await app.request("/webhook/plainsecret")).status).toBe(404);
    expect(await agent.flushNow()).toBe(true);
    const unmatched = endpointsOf(sink.batches[0]).filter((e) => !e.route.startsWith("/"));
    expect(unmatched.map((e) => `${e.method} ${e.route} ${e.status.clientError}`)).toEqual(["GET (unmatched) 1"]);
    expect(JSON.stringify(sink.batches)).not.toContain("plainsecret");
  });

  it("counts a request served by @hono/node-server once, by its template, and an app.request() beside it once", async () => {
    const { agent, sink, app } = await started();
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/v1/users/7`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect((await app.request("/v1/users/8")).status).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    const users = endpointsOf(sink.batches[0]).find((e) => e.route === "/v1/users/:userId");
    expect(users?.count).toBe(2);
    expect(users?.dependencies?.[0]?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("closes each request with the status Hono answered", async () => {
    const { agent, sink, app } = await started();
    app.get("/v1/forbidden", () => {
      throw new HTTPException(403, { message: "no" });
    });
    app.get("/v1/broken", () => {
      throw new Error("broken");
    });
    app.get("/v1/created", (c) => c.text("made", 201));
    const guarded = new Hono();
    guarded.use(async (_c, next) => {
      await next();
    });
    guarded.get("/teapot", () => {
      throw new Error("short and stout");
    });
    guarded.onError((_err, c) => c.text("teapot", 418));
    app.route("/v1", guarded);
    expect((await app.request("/v1/forbidden")).status).toBe(403);
    expect((await app.request("/v1/broken")).status).toBe(500);
    expect((await app.request("/v1/created")).status).toBe(201);
    // Behind a middleware, the error handler of the application answers inside Hono's chain, and its status is seen.
    expect((await app.request("/v1/teapot")).status).toBe(418);
    expect(await agent.flushNow()).toBe(true);
    const statuses = Object.fromEntries(endpointsOf(sink.batches[0]).map((e) => [e.route, e.status]));
    expect(statuses["/v1/forbidden"]).toMatchObject({ clientError: 1, serverError: 0 });
    expect(statuses["/v1/broken"]).toMatchObject({ clientError: 0, serverError: 1 });
    expect(statuses["/v1/created"]).toMatchObject({ success: 1 });
    expect(statuses["/v1/teapot"]).toMatchObject({ clientError: 1, serverError: 0 });
  });

  it("answers as it would if opening or closing the request throws, and counts the failure (invariant 2)", async () => {
    const failures: unknown[] = [];
    const broken = new Error("the doors broke");
    const stop = attachHono({
      from: applicationEntry({ preserveSymlinksMain: false }),
      log: quiet,
      internalError: (err) => failures.push(err),
      unannounced: {
        announced: () => false,
        started: () => {
          throw broken;
        },
        finished: () => {
          throw broken;
        },
      },
    });
    cleanups.push(stop);
    await wrapped();
    const app = new Hono();
    app.get("/users/:id", (c) => c.json({ ok: true }));
    const res = await app.request("/users/1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Opening failed, so nothing was opened, and there is nothing to close.
    expect(failures).toEqual([broken]);
  });

  it("opens nothing once the instrumentation stopped, though the wrappers stay with the routers", async () => {
    const opened: object[] = [];
    const stop = attachHono({
      from: applicationEntry({ preserveSymlinksMain: false }),
      log: quiet,
      internalError: () => {},
      unannounced: { announced: () => false, started: (request) => opened.push(request), finished: () => {} },
    });
    await wrapped();
    stop();
    const app = new Hono();
    app.get("/users/:id", (c) => c.json({ ok: true }));
    expect((await app.request("/users/1")).status).toBe(200);
    expect(opened).toEqual([]);
  });

  it("declares the routes of the router that answered for check: one per method, and none for a middleware or all", async () => {
    const opened: object[] = [];
    const stop = attachHono({
      from: applicationEntry({ preserveSymlinksMain: false }),
      log: quiet,
      internalError: () => {},
      unannounced: { announced: () => false, started: (request) => opened.push(request), finished: () => {} },
    });
    cleanups.push(stop);
    await wrapped();
    const items = new Hono();
    items.use("*", async (_c, next) => {
      await next();
    });
    items.put("/:id", (c) => c.text("put"));
    items.patch("/:id", (c) => c.text("patch"));
    const app = new Hono();
    app.get("/health", (c) => c.text("ok"));
    app.all("/graphql", (c) => c.text("graphql"));
    app.route("/items", items);
    expect((await app.request("/health")).status).toBe(200);
    const [request] = opened;
    expect(declaredRoutesOf(honoRouterOf(request as object)).sort()).toEqual([
      "GET /health",
      "PATCH /items/:id",
      "PUT /items/:id",
    ]);
  });
});
