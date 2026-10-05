import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import Router from "@koa/router";
import { Ajv2020 } from "ajv/dist/2020.js";
import Koa from "koa";
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

/** Starts listening on a port of its own, and closes the server after the test. */
async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The routers the target user runs: the one a current application installs, and the one Strapi 5 pins.
const Router12 = createRequire(import.meta.url)("@koa/router12") as typeof Router;

/**
 * DT-90. A Koa application used to be named by the heuristic over the path, and Strapi 5 runs on Koa: a
 * route of its content API is `/api/articles/:id`, and the heuristic leaves a slug as written — so each
 * article was a route of its own in the profile, and its name travelled.
 *
 * Real Koa (the package's devDependency), real routers, real agent, real batch, like the Express tests next
 * door. The agent starts **before** the first request and not before the application is built: nothing is
 * loaded at start-up, and the wrapper goes in from the first request (ADR 0209) — on the prototype, so an
 * application built earlier is covered.
 */
describe.each([
  ["@koa/router 15", Router],
  ["@koa/router 12, the one Strapi 5 pins", Router12],
])("a Koa application with %s is named by its templates (DT-90)", (_name, RouterClass) => {
  async function serve(build: (app: Koa) => void) {
    const sink = await startSink();
    const app = new Koa();
    build(app);
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const url = await listen(http.createServer(app.callback()));
    cleanups.push(() => agent.stop(), sink.close);
    return { url, agent, sink };
  }

  it("names the routes of a Strapi content API, composed the way Strapi composes them, by their templates", async () => {
    // `createAPI` + `routes` + `mount` of @strapi/core 5.56: a router with the prefix, a route per action with
    // its own path, mounted on the application's router. Both are the application's, and none of it is read
    // from the request.
    const { url, agent, sink } = await serve((app) => {
      const root = new RouterClass();
      const api = new RouterClass({ prefix: "/api" });
      for (const [path, name] of [
        ["/articles", "find"],
        ["/articles/:id", "findOne"],
      ] as const) {
        api.get(path, (ctx) => {
          ctx.body = { action: name };
        });
      }
      root.use(api.routes(), api.allowedMethods());
      app.use(root.routes()).use(root.allowedMethods());
    });

    await hit(url, "/api/articles/1");
    await hit(url, "/api/articles/2");
    await hit(url, "/api/articles/mi-secreto-de-familia");
    await hit(url, "/api/articles");
    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    const byRoute = routesOf(batch);
    expect(Object.fromEntries(byRoute), "one route for every article, named by the template Strapi matched").toEqual({
      "/api/articles/:id": 3,
      "/api/articles": 1,
    });
    const body = JSON.stringify(batch);
    expect(body, "the slug does not leave").not.toContain("mi-secreto");
  });

  it("names a route of a plain Koa application by the path it was registered with", async () => {
    const { url, agent, sink } = await serve((app) => {
      const router = new RouterClass();
      router.get("/users/:id", (ctx) => {
        ctx.body = {};
      });
      app.use(router.routes());
    });

    await hit(url, "/users/42");
    await hit(url, "/users/ana-garcia");
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(Object.fromEntries(routesOf(batch))).toEqual({ "/users/:id": 2 });
    expect(JSON.stringify(batch), "a name in the path does not leave").not.toContain("ana-garcia");
  });

  it("keeps the parameters of every router a route is nested in out of the template", async () => {
    const { url, agent, sink } = await serve((app) => {
      const inner = new RouterClass({ prefix: "/teams/:team" });
      inner.get("/users/:id", (ctx) => {
        ctx.body = {};
      });
      const outer = new RouterClass({ prefix: "/tenants/:tenant" });
      outer.use(inner.routes());
      app.use(outer.routes());
    });

    await hit(url, "/tenants/acme-corp/teams/team-7/users/42");
    await hit(url, "/tenants/otro/teams/t-2/users/9");
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(Object.fromEntries(routesOf(batch))).toEqual({ "/tenants/:tenant/teams/:team/users/:id": 2 });
    const body = JSON.stringify(batch);
    for (const value of ["acme-corp", "team-7", "otro", "t-2"]) {
      expect(body, `«${value}» does not leave`).not.toContain(value);
    }
  });

  it("names a request no route of the router matched (unmatched), and nothing of its path travels (DT-56)", async () => {
    // Routes were there to name it and none did: a path nobody registered, and a path that is registered for
    // another method. A plain word in the path is no more a name here than it is in Express's 404.
    const { url, agent, sink } = await serve((app) => {
      const router = new RouterClass();
      router.get("/users/:id", (ctx) => {
        ctx.body = {};
      });
      app.use(router.routes());
      app.use((ctx) => {
        ctx.status = 404;
      });
    });

    expect(await hit(url, "/orders/42")).toBe(404);
    expect(await hit(url, "/webhook/plainsecret")).toBe(404);
    expect(await hit(url, "/orders/ana@cliente.com")).toBe(404);
    expect(await hit(url, "/users/7")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    expect(Object.fromEntries(routesOf(batch))).toEqual({ "(unmatched)": 3, "/users/:id": 1 });
    const body = JSON.stringify(batch);
    for (const word of ["orders", "plainsecret", "ana@cliente"]) {
      expect(body, `«${word}» does not leave`).not.toContain(word);
    }
  });

  it("names a request no route matched in a Koa application with no router by the heuristic, as before", async () => {
    // With no router there are no routes to name it by, and the heuristic is all there is.
    const { url, agent, sink } = await serve((app) => {
      app.use((ctx) => {
        ctx.status = 404;
      });
    });

    expect(await hit(url, "/orders/42")).toBe(404);
    expect(await hit(url, "/orders/ana@cliente.com")).toBe(404);
    expect(await agent.flushNow()).toBe(true);
    expect(Object.fromEntries(routesOf(sink.batches[0]))).toEqual({ "/orders/:id": 2 });
  });

  it("names a route that hands on to the middleware after it by the route, as Strapi's static files need", async () => {
    // Strapi serves its public folder from a catch-all route that calls `next()` first, and every middleware
    // the router holds runs after it: what the router leaves on the context is the last of those, a path
    // that names no route. A file's name is what the path carries here, and it does not leave.
    const { url, agent, sink } = await serve((app) => {
      const router = new RouterClass();
      router.get("/files/:name", async (ctx, next) => {
        await next();
        ctx.body = ctx.body ?? "a file";
      });
      router.use(async (_ctx, next) => next());
      router.use(async (_ctx, next) => next());
      app.use(router.routes());
    });

    await hit(url, "/files/ana-garcia.pdf");
    await hit(url, "/files/nominas-2026.pdf");
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(Object.fromEntries(routesOf(batch))).toEqual({ "/files/:name": 2 });
    expect(JSON.stringify(batch), "the file's name does not leave").not.toContain("ana-garcia");
  });

  it("names the first request too, which is the one that finds Koa", async () => {
    const { url, agent, sink } = await serve((app) => {
      const router = new RouterClass();
      router.get("/users/:id", (ctx) => {
        ctx.body = {};
      });
      app.use(router.routes());
    });
    await hit(url, "/users/1");
    expect(await agent.flushNow()).toBe(true);
    expect(Object.fromEntries(routesOf(sink.batches[0]))).toEqual({ "/users/:id": 1 });
  });
});

describe("an agent with no Koa to find (DT-90)", () => {
  it("reads the module cache once, from the first request, and names the routes as it did", async () => {
    const sink = await startSink();
    let reads = 0;
    const moduleCache = new Proxy(
      {},
      {
        ownKeys() {
          reads += 1;
          return [];
        },
      },
    );
    const agent = createAgent(config(sink.url), { log: quiet, moduleCache });
    agent.start();
    const server = http.createServer((_req, res) => {
      res.writeHead(200).end("ok");
    });
    const url = await listen(server);
    cleanups.push(() => agent.stop(), sink.close);

    expect(reads, "nothing is read at start-up").toBe(0);
    await hit(url, "/users/42");
    expect(reads, "the first request looks").toBe(1);
    await hit(url, "/users/43");
    await hit(url, "/users/44");
    expect(reads, "and no request after it").toBe(1);
    expect(await agent.flushNow()).toBe(true);
    expect(Object.fromEntries(routesOf(sink.batches[0]))).toEqual({ "/users/:id": 3 });
  });

  it("goes on when the module cache cannot be read, and the request is the application's all the same", async () => {
    const sink = await startSink();
    const moduleCache = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("the cache cannot be listed");
        },
      },
    );
    const agent = createAgent(config(sink.url), { log: quiet, moduleCache });
    agent.start();
    const url = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200).end("ok");
      }),
    );
    cleanups.push(() => agent.stop(), sink.close);

    expect(await hit(url, "/users/42")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    expect(Object.fromEntries(routesOf(sink.batches[0]))).toEqual({ "/users/:id": 1 });
  });
});

/**
 * DT-90. Next.js names the file that serves a request on the request itself. What the test puts there is the
 * shape read off Next 13.5 to 16.3 running for real — `packages/agent/README.md` lists what was checked; Next
 * is not a devDependency of this package, and nothing here loads it — so what this proves is that the agent
 * reads it and what leaves, and not that Next writes it.
 */
describe("a Next.js application is named by its templates (DT-90)", () => {
  const META = Symbol.for("NextInternalRequestMeta");

  /** A server that does what Next's does with a request: leaves the match on it, and answers. */
  function nextLike(): http.Server {
    return http.createServer((req, res) => {
      const url = req.url ?? "/";
      let pathname: string | undefined;
      if (url.startsWith("/api/products/")) pathname = "/api/products/[id]";
      else if (url.startsWith("/blog/")) pathname = "/blog/[slug]";
      else if (url.startsWith("/_next/static/")) pathname = undefined;
      else pathname = "/_not-found";
      (req as unknown as Record<symbol, unknown>)[META] =
        pathname === undefined
          ? { initURL: url }
          : { match: { definition: { kind: "APP_ROUTE", pathname }, params: {} } };
      res.writeHead(pathname === "/_not-found" ? 404 : 200).end("ok");
    });
  }

  it("names a route handler and a page by the file that serves them, and nothing of the path travels", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const url = await listen(nextLike());
    cleanups.push(() => agent.stop(), sink.close);

    await hit(url, "/api/products/7");
    await hit(url, "/api/products/8?color=red");
    await hit(url, "/blog/ana-garcia-lopez");
    await hit(url, "/wp-admin/ana-garcia");
    await hit(url, "/_next/static/chunks/main-app-3f2a1b.js");
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);

    expect(Object.fromEntries(routesOf(batch))).toEqual({
      "/api/products/[id]": 2,
      "/blog/[slug]": 1,
      "/_not-found": 1,
      // What Next did not route is the heuristic's, as before.
      "/_next/static/chunks/:id": 1,
    });
    const body = JSON.stringify(batch);
    for (const word of ["ana-garcia", "color", "wp-admin"]) {
      expect(body, `«${word}» does not leave`).not.toContain(word);
    }
  });
});
