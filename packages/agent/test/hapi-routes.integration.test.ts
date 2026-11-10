import { spawn } from "node:child_process";
import diagnostics_channel from "node:diagnostics_channel";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import Hapi from "@hapi/hapi";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "../src/agent.ts";
import { currentContext } from "../src/context.ts";
import { attachHapi, hapiRouterOf, patchHapiRequest } from "../src/hapi.ts";
import type { Logger } from "../src/log.ts";
import { declaredRoutesOf } from "../src/routes.ts";
import { testConfig } from "./support/agent-config.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const keyword of [
  "x-latency-boundaries-ms",
  "x-calls-per-request-boundaries",
  "x-ingest-path",
  "x-since",
  "x-error",
]) {
  ajv.addKeyword(keyword);
}
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

function routesOf(batch: AggregatesBatch | undefined): Record<string, number> {
  const byRoute: Record<string, number> = {};
  for (const interval of (batch?.intervals ?? []) as Interval[]) {
    for (const e of interval.endpoints)
      byRoute[`${e.method} ${e.route}`] = (byRoute[`${e.method} ${e.route}`] ?? 0) + e.count;
  }
  return byRoute;
}

async function hit(url: string, path: string, method = "GET"): Promise<number> {
  const res = await fetch(url + path, { method });
  await res.arrayBuffer();
  return res.status;
}

/**
 * What Node 18.19 to 22.3 announce on the `module.require` channel: nothing. Node still announces there, and the
 * instrumentation is handed a channel of another name, on which nothing is ever announced, whichever Node this runs.
 */
const UNANNOUNCED = "downtrace.test.unannounced";
function announcingNothing(name: string): string {
  return name === "module.require" ? UNANNOUNCED : name;
}

/**
 * Hapi used to be named by the heuristic over the path: `/users/42` came out as `/users/:id` by luck of the digits,
 * `/users/ana` as itself. Hapi says which route it matched, prefix included, and the instrumentation asks it.
 *
 * Real Hapi 21, real agent, real batch: its routes, a plugin registered under a prefix, and a request no route matched.
 */
describe("a Hapi application is named by its templates", () => {
  async function application(instrument: Set<"http"> = new Set()) {
    const sink = await startSink();
    const upstream = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const agent = createAgent(
      testConfig(sink.url, { environment: "test", version: "t1", intervalMs: 60_000, instrument }),
      { log: quiet },
    );
    agent.start();
    const server = Hapi.server({ port: 0, host: "127.0.0.1" });
    server.route({
      method: "GET",
      path: "/users/{id}",
      handler: async () => {
        await (await fetch(`${up}/profile`)).text();
        return { ok: true };
      },
    });
    server.route({ method: ["PUT", "PATCH"], path: "/items/{id}", handler: () => "item" });
    await server.register(
      {
        name: "orders",
        register: (api) => {
          api.route({ method: "POST", path: "/orders/{id?}", handler: () => "order" });
        },
      },
      { routes: { prefix: "/api" } },
    );
    cleanups.push(
      sink.close,
      () => new Promise<void>((r) => upstream.close(() => r())),
      () => agent.stop(),
      () => server.stop(),
    );
    return { agent, sink, server, upstream: up.slice("http://".length) };
  }

  it("names each request by the route Hapi matched, a plugin's prefix included, and none of its values travel", async () => {
    const { agent, sink, server } = await application();
    await server.start();
    const url = server.info.uri;
    expect(await hit(url, "/users/ana")).toBe(200);
    expect(await hit(url, "/users/42")).toBe(200);
    expect(await hit(url, "/items/9", "PATCH")).toBe(200);
    expect(await hit(url, "/api/orders/acme-7", "POST")).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    // The upstream the handler calls is a server of this process, and its own requests are routes of it.
    const { "GET /profile": upstream, ...hapi } = routesOf(batch);
    expect(upstream).toBe(2);
    expect(hapi).toEqual({
      "GET /users/{id}": 2,
      "PATCH /items/{id}": 1,
      "POST /api/orders/{id?}": 1,
    });
    const body = JSON.stringify(batch);
    for (const word of ["ana", "acme-7"]) expect(body, `«${word}» does not leave`).not.toContain(word);
  });

  it("names a request no route matched (unmatched), and nothing of its path travels", async () => {
    const { agent, sink, server } = await application();
    await server.start();
    expect(await hit(server.info.uri, "/webhook/plainsecret")).toBe(404);
    expect(await agent.flushNow()).toBe(true);
    expect(routesOf(sink.batches[0])).toEqual({ "GET (unmatched)": 1 });
    expect(JSON.stringify(sink.batches)).not.toContain("plainsecret");
  });

  /**
   * Hapi's testing guide, and Lab's, call an application with `server.inject()`, which hands Hapi a request of Shot's and
   * never goes through Node's server: Node announces nothing, and a suite written that way called no route for `check`.
   */
  it("observes a request made with inject() by its template and with what it did, apart from the test", async () => {
    const { agent, sink, server, upstream } = await application(new Set(["http"]));
    await server.initialize();
    expect((await server.inject("/users/ana")).statusCode).toBe(200);
    expect(currentContext(), "the test that injected is not inside the request it made").toBeUndefined();
    expect((await server.inject("/users/42")).statusCode).toBe(200);
    // The test's own call after the request is the test's, and belongs to no route.
    await (await fetch(`http://${upstream}/after`)).text();
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    const users = (batch?.intervals ?? []).flatMap((i) => i.endpoints).find((e) => e.route === "/users/{id}");
    expect(users?.count).toBe(2);
    const [dependency] = users?.dependencies ?? [];
    expect(dependency).toMatchObject({ kind: "http", target: upstream });
    expect(dependency?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(2);
    expect(JSON.stringify(batch)).not.toContain("ana");
  });

  it("names an injected request no route matched (unmatched), and nothing of its path travels", async () => {
    const { agent, sink, server } = await application();
    await server.initialize();
    expect((await server.inject("/webhook/plainsecret")).statusCode).toBe(404);
    expect(await agent.flushNow()).toBe(true);
    expect(routesOf(sink.batches[0])).toEqual({ "GET (unmatched)": 1 });
    expect(JSON.stringify(sink.batches)).not.toContain("plainsecret");
  });

  it("counts a request that came through the server once, and not again as injected", async () => {
    const { agent, sink, server } = await application(new Set(["http"]));
    await server.start();
    expect(await hit(server.info.uri, "/users/7")).toBe(200);
    expect((await server.inject("/users/8")).statusCode).toBe(200);
    expect(await agent.flushNow()).toBe(true);
    const users = (sink.batches[0]?.intervals ?? []).flatMap((i) => i.endpoints).find((e) => e.route === "/users/{id}");
    expect(users?.count).toBe(2);
    expect(users?.dependencies?.[0]?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

/**
 * DT-165 and DT-175. Node announces what modules require only from Node 22.4, and with `--import` the instrumentation
 * starts before the application loads Hapi. Before 22.4 nothing patched Hapi's request class: a Hapi application was
 * named by the heuristic, `/users/ana` as itself; and then only from the first request Node's server received, which a
 * suite that only injects never makes, so on Node 18.19 it wrote no route at all.
 *
 * The application here is a process of its own, started with the register entry and a Node that announces nothing on
 * that channel, as Node 18.19 to 22.3 announce nothing; it imports Hapi after the start, and calls it.
 */
describe("a Hapi the application loads after the start, on a Node that announces no module loads", () => {
  const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
  const unannounced = `import dc from "node:diagnostics_channel";
const tracingChannel = dc.tracingChannel;
dc.tracingChannel = (name) => tracingChannel(name === "module.require" ? ${JSON.stringify(UNANNOUNCED)} : name);`;
  const application = (call: string): string => `import Hapi from "@hapi/hapi";
const server = Hapi.server({ port: 0, host: "127.0.0.1" });
server.route({ method: "GET", path: "/users/{id}", handler: (request) => ({ id: request.params.id }) });
${call}
for (const path of ["/users/ana", "/users/42"]) {
  const status = await ask(path);
  if (status !== 200) throw new Error(path + " answered " + status);
}
await server.stop();`;
  const CALLS = {
    "only injects, as Hapi's guide and Lab do": `await server.initialize();
const ask = async (path) => (await server.inject(path)).statusCode;`,
    "calls it through Node's server": `await server.start();
const ask = async (path) => {
  const res = await fetch(server.info.uri + path);
  await res.arrayBuffer();
  return res.status;
};`,
  };

  function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; err: string }> {
    return new Promise((resolve, reject) => {
      // From this package, which has Hapi: an `-e` application resolves from the working directory.
      const child = spawn(process.execPath, args, { cwd: fileURLToPath(new URL("..", import.meta.url)), env });
      let err = "";
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, err }));
    });
  }

  it.each(Object.entries(CALLS))("names each request by its template when the suite %s", async (_how, call) => {
    const dir = mkdtempSync(join(tmpdir(), "downtrace-hapi-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const inspect = join(dir, "run.jsonl");
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("DOWNTRACE_") || key === "NODE_OPTIONS") delete env[key];
    const child = await run(
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(unannounced)}`,
        "--import",
        register,
        "--input-type=module",
        "-e",
        application(call),
      ],
      { ...env, DOWNTRACE_INSPECT: inspect },
    );
    expect(child.code, child.err).toBe(0);
    expect(child.err).not.toContain("[downtrace]");
    const batches = existsSync(inspect)
      ? readFileSync(inspect, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as AggregatesBatch)
      : [];
    const written: Record<string, number> = {};
    for (const batch of batches) {
      for (const [route, count] of Object.entries(routesOf(batch))) written[route] = (written[route] ?? 0) + count;
    }
    expect(written).toEqual({ "GET /users/{id}": 2 });
    expect(JSON.stringify(batches)).not.toContain("ana");
  });
});

describe("attachHapi, when the instrumentation's own doors fail or it stopped", () => {
  async function server() {
    const app = Hapi.server();
    app.route({ method: "GET", path: "/users/{id}", handler: () => ({ ok: true }) });
    await app.initialize();
    cleanups.push(() => app.stop());
    return app;
  }

  it("answers an injected request as it would if opening or closing it throws, and counts the failure (invariant 2)", async () => {
    const failures: unknown[] = [];
    const broken = new Error("the doors broke");
    const stop = attachHapi({
      from: import.meta.filename,
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
    const res = await (await server()).inject("/users/1");
    expect(res.statusCode).toBe(200);
    expect(res.result).toEqual({ ok: true });
    expect(failures).toEqual([broken]);
  });

  /**
   * DT-175. Where Node announces no module loads, the start loads Hapi's request class itself. A Hapi whose class
   * cannot be loaded is one the application meets as it loads Hapi, and nothing of the instrumentation's own.
   */
  it("starts as without Hapi when its request class throws as the start loads it, on a Node that announces no loads (invariant 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "downtrace-hapi-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lib = join(dir, "node_modules", "@hapi", "hapi", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "..", "package.json"), JSON.stringify({ name: "@hapi/hapi", main: "lib/index.js" }));
    writeFileSync(join(lib, "index.js"), "");
    writeFileSync(join(lib, "request.js"), 'throw new Error("a broken install");');
    const tracingChannel = diagnostics_channel.tracingChannel;
    const spy = vi
      .spyOn(diagnostics_channel, "tracingChannel")
      .mockImplementation((name) => tracingChannel(announcingNothing(String(name))));
    cleanups.push(() => spy.mockRestore());
    const failures: unknown[] = [];
    const said: string[] = [];
    const stop = attachHapi({
      from: join(dir, "app.js"),
      log: { warn: (line) => said.push(line), debug: (line) => said.push(line) },
      internalError: (err) => failures.push(err),
    });
    cleanups.push(stop);
    expect(failures).toEqual([]);
    expect(said).toEqual([expect.stringMatching(/^hapi: .*request\.js not loaded: Error: a broken install$/)]);
  });

  /**
   * ESC-18: `check` names a route no test called only from the routes the application declares. A Hapi server keeps
   * them in its router, plugins' included, and a request it answered — matched or not — says which server that was.
   */
  it("declares the routes of the server that answered for check: one per method, as a request gets it, and none for every method", async () => {
    const stop = attachHapi({ from: import.meta.filename, log: quiet, internalError: () => {} });
    cleanups.push(stop);
    const app = Hapi.server();
    app.route({ method: "GET", path: "/users/{id}", handler: () => "user" });
    app.route({ method: ["PUT", "PATCH"], path: "/items/{id}", handler: () => "item" });
    app.route({ method: "*", path: "/graphql", handler: () => "graphql" });
    await app.register(
      {
        name: "orders",
        register: (api) => {
          api.route({ method: "POST", path: "/orders/{id?}", handler: () => "order" });
        },
      },
      { routes: { prefix: "/api" } },
    );
    await app.initialize();
    cleanups.push(() => app.stop());
    const matched = await app.inject("/users/ana");
    expect(matched.statusCode).toBe(200);
    const nowhere = await app.inject("/nowhere");
    expect(nowhere.statusCode).toBe(404);
    // A route registered after the server answered is one it declares too: the router is read when the routes are.
    app.route({ method: "DELETE", path: "/sessions/{id}", handler: () => "gone" });
    const expected = [
      "DELETE /sessions/{id}",
      "GET /users/{id}",
      "PATCH /items/{id}",
      "POST /api/orders/{id?}",
      "PUT /items/{id}",
    ];
    for (const res of [matched, nowhere]) {
      const req = (res.request as unknown as { raw: { req: object } }).raw.req;
      expect(declaredRoutesOf(hapiRouterOf(req)).sort()).toEqual(expected);
    }
  });

  it("declares nothing for a server whose router cannot be read, and never throws (invariant 2)", () => {
    class Request {
      raw = { req: {} };
      route = { path: "/x" };
      _core = {
        router: {
          table: () => {
            throw new Error("no");
          },
        },
      };
      _lookup(): void {}
      _execute(): void {}
    }
    expect(patchHapiRequest(Request)).toBe(true);
    const request = new Request();
    request._lookup();
    const router = hapiRouterOf(request.raw.req);
    expect(router).toBe(request._core.router);
    expect(declaredRoutesOf(router)).toEqual([]);
  });

  it("opens nothing once the instrumentation stopped, though the wrappers stay with the class", async () => {
    const opened: object[] = [];
    const stop = attachHapi({
      from: import.meta.filename,
      log: quiet,
      internalError: () => {},
      unannounced: { announced: () => false, started: (request) => opened.push(request), finished: () => {} },
    });
    const app = await server();
    stop();
    expect((await app.inject("/users/1")).statusCode).toBe(200);
    expect(opened).toEqual([]);
  });
});
