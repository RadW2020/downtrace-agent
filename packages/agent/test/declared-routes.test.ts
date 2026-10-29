import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import express4 from "express4";
import { afterEach, describe, expect, it } from "vitest";
import { armDispatchRecording, armMountRecording } from "../src/mounts.ts";
import { declaredRoutesOf, routeOf } from "../src/routes.ts";

/**
 * ESC-18 without a list written by hand: `downtrace check` names a route no test called only if it knows the
 * route exists, and an Express application already says which routes it has. `declaredRoutesOf` reads them off
 * the router, and every name it gives must be the one `routeOf` gives a request to that route — otherwise a
 * route that was called would also come out as one that was not.
 *
 * Real Express 5 and Express 4, with the mount record armed the way `Agent.start()` arms it.
 */

armMountRecording(express.Router.prototype) || armMountRecording(express.Router);
armDispatchRecording((express as unknown as { Route: { prototype: unknown } }).Route.prototype);
armMountRecording(express4.Router);
armDispatchRecording((express4 as unknown as { Route: { prototype: unknown } }).Route.prototype);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

type Express = typeof express | typeof express4;

/** An application with each shape of route the walk reads, and the shapes it must leave unnamed. */
function application(framework: Express, seen: string[]) {
  const app = (framework as typeof express)();
  app.use((req, res, next) => {
    res.on("finish", () => seen.push(`${req.method} ${routeOf(req)}`));
    next();
  });
  app.get("/health", (_req, res) => res.send("ok"));
  app
    .route("/items/:id")
    .get((_req, res) => res.send("item"))
    .put((_req, res) => res.send("put"));

  const tenants = (framework as typeof express).Router();
  tenants.get("/users/:id", (_req, res) => res.send("user"));

  const api = (framework as typeof express).Router();
  api.post("/orders", (_req, res) => res.send("order"));
  api.use("/tenants/:tenant", tenants);
  app.use("/api", api);

  // A router mounted with no path takes nothing of the path, and its routes are the app's own.
  const flat = (framework as typeof express).Router();
  flat.delete("/sessions/:id", (_req, res) => res.send("gone"));
  app.use(flat);

  // Shapes with no single name: `all` answers every method, and a regular expression has no template.
  app.all("/any", (_req, res) => res.send("any"));
  app.get(/^\/pattern$/, (_req, res) => res.send("pattern"));
  return app;
}

const EXPECTED = [
  "DELETE /sessions/:id",
  "GET /api/tenants/:tenant/users/:id",
  "GET /health",
  "GET /items/:id",
  "POST /api/orders",
  "PUT /items/:id",
];

async function serve(app: http.RequestListener): Promise<string> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function hit(base: string, method: string, path: string): Promise<void> {
  const res = await fetch(base + path, { method });
  await res.arrayBuffer();
}

for (const [name, framework] of [
  ["Express 5", express],
  ["Express 4", express4],
] as const) {
  describe(`the routes an ${name} application declares`, () => {
    it("are every route with a method and a template, mounts included, by their patterns", () => {
      expect(declaredRoutesOf(application(framework, [])).sort()).toEqual(EXPECTED);
    });

    it("are named as a request to each of them is named, so a route that was called is never also not called", async () => {
      const seen: string[] = [];
      const base = await serve(application(framework, seen) as unknown as http.RequestListener);
      await hit(base, "GET", "/health");
      await hit(base, "GET", "/items/7");
      await hit(base, "PUT", "/items/7");
      await hit(base, "POST", "/api/orders");
      await hit(base, "GET", "/api/tenants/acme/users/42");
      await hit(base, "DELETE", "/sessions/abc");
      expect(seen.sort()).toEqual(EXPECTED);
    });

    it("leave out what has no single name: a route for every method, and one written as a regular expression", () => {
      const declared = declaredRoutesOf(application(framework, []));
      expect(declared.some((route) => route.includes("/any"))).toBe(false);
      expect(declared.some((route) => route.includes("pattern"))).toBe(false);
    });
  });
}

describe("declaredRoutesOf", () => {
  it("is empty for what is not an Express application, and never throws on it", () => {
    for (const value of [undefined, null, 42, "app", {}, () => {}, { _router: { stack: "no" } }]) {
      expect(declaredRoutesOf(value)).toEqual([]);
    }
  });

  it("does not let an application whose router throws on a read reach the caller (invariant 2)", () => {
    const hostile = Object.defineProperty(() => {}, "_router", {
      get() {
        throw new Error("no");
      },
    });
    expect(declaredRoutesOf(hostile)).toEqual([]);
  });

  it("leaves out the routes of a mount whose pattern was not recorded, rather than guess its words", () => {
    const app = express();
    const router = express.Router();
    router.get("/x", (_req, res) => res.send("x"));
    app.use("/known", router);
    // The record is a WeakMap kept by `mounts.ts`; a layer pushed by hand was never registered through `use`.
    const stack = (app as unknown as { router: { stack: Array<{ handle: unknown }> } }).router.stack;
    const recorded = stack[stack.length - 1];
    stack.push({ ...recorded, handle: router } as never);
    expect(declaredRoutesOf(app)).toEqual(["GET /known/x"]);
  });
});
