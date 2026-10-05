import { createRequire } from "node:module";
import Router from "@koa/router";
import Koa from "koa";
import { describe, expect, it } from "vitest";
import { armContextRecording, attachKoa, koaMatchedRoute, koaRouterSawRequest } from "../src/koa.ts";
import type { Logger } from "../src/log.ts";
import { routeOf } from "../src/routes.ts";

const MARK = Symbol.for("downtrace.koa.context");

const quiet: Logger = { warn: () => {}, debug: () => {} };

/** An `Application` as far as the recording is concerned: a class whose `createContext` builds a context. */
function fakeApplication() {
  class Application {
    created: unknown[][] = [];
    createContext(req: object, res: object): Record<string, unknown> {
      this.created.push([req, res]);
      return { req, res };
    }
  }
  return Application;
}

describe("koaMatchedRoute", () => {
  it("is nothing for a request Koa never made a context for", () => {
    expect(koaMatchedRoute({})).toBeUndefined();
  });

  it("reads the path the router matched off the context made for the request", () => {
    const Application = fakeApplication();
    armContextRecording(Application.prototype, () => {});
    const app = new Application();
    const req = {};
    const ctx = app.createContext(req, {});
    expect(koaMatchedRoute(req), "before any router matched").toBeUndefined();
    ctx._matchedRoute = "/api/articles/:id";
    expect(koaMatchedRoute(req)).toBe("/api/articles/:id");
  });

  it("is nothing for a matched route that is not a path", () => {
    // `koa-router` accepts a regular expression for a route, and the matched route is then the expression
    // itself: it has no template to read, and the heuristic names the request.
    const Application = fakeApplication();
    armContextRecording(Application.prototype, () => {});
    const app = new Application();
    for (const matched of [/^\/users\/(\d+)$/, 42, null, ["/a", "/b"], {}]) {
      const req = {};
      app.createContext(req, {})._matchedRoute = matched;
      expect(koaMatchedRoute(req), String(matched)).toBeUndefined();
    }
  });

  describe("when the router keeps the layers it matched", () => {
    const route = (path: string, ...methods: string[]) => ({
      path,
      methods: methods.length ? methods : ["HEAD", "GET"],
    });
    const middleware = (path: string) => ({ path, methods: [] });

    /** A request whose context holds what a router left on it, read through the recording. */
    function requestWith(left: { _matchedRoute?: unknown; matched?: unknown }): object {
      const Application = fakeApplication();
      armContextRecording(Application.prototype, () => {});
      const req = {};
      Object.assign(new Application().createContext(req, {}), left);
      return req;
    }

    it("is the path of the route that answered, when the layer the router named is that route", () => {
      const layers = [middleware("([^/]*)"), route("/users/:id"), route("/users/:id", "DELETE")];
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "/users/:id", matched: layers }))).toBe("/users/:id");
    });

    it("is the route a middleware came after, when the router named the middleware: a route that handed on", () => {
      // Strapi's static files, admin panel and 404s: the route calls `next()`, and every middleware the router
      // holds after it runs, the last one leaving its own path where the route's should be.
      const layers = [route("/files/:name"), middleware("([^/]*)"), middleware("([^/]*)")];
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "([^/]*)", matched: layers }))).toBe("/files/:name");
    });

    it("is the last route the request was dispatched to, not the first that matched", () => {
      const layers = [route("/admin/:path*"), route("/((?!uploads/).+)"), middleware("([^/]*)")];
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "([^/]*)", matched: layers }))).toBe("/((?!uploads/).+)");
      // And when the first route answered, the second never ran, and the router named the first.
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "/admin/:path*", matched: layers }))).toBe("/admin/:path*");
    });

    it("stands as the router wrote it when no route comes before the layer it names", () => {
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "([^/]*)", matched: [middleware("([^/]*)")] }))).toBe(
        "([^/]*)",
      );
      // A layer list that does not hold the path it names: another router's, or none the walk can read.
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "/users/:id", matched: [route("/other")] }))).toBe(
        "/users/:id",
      );
      for (const matched of [undefined, null, "layers", 42, {}]) {
        expect(koaMatchedRoute(requestWith({ _matchedRoute: "/users/:id", matched })), String(matched)).toBe(
          "/users/:id",
        );
      }
    });

    it("goes past a layer that is not the shape read", () => {
      const layers = [route("/files/:name"), null, undefined, 7, "layer", {}, { path: "x" }, { path: 3, methods: [] }];
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "x", matched: layers }))).toBe("/files/:name");
      const noMethods = [{ path: "/a", methods: "GET" }, { path: "/b", methods: null }, middleware("/c")];
      expect(koaMatchedRoute(requestWith({ _matchedRoute: "/c", matched: noMethods }))).toBe("/c");
    });

    it("is nothing, and throws nothing, when reading a layer throws", () => {
      const hostile = {
        get path(): string {
          throw new Error("a getter");
        },
        methods: ["GET"],
      };
      const req = requestWith({ _matchedRoute: "/users/:id", matched: [hostile] });
      expect(() => koaMatchedRoute(req)).not.toThrow();
      expect(koaMatchedRoute(req)).toBeUndefined();
    });
  });

  it("is nothing, and throws nothing, when reading the context throws", () => {
    const Application = class {
      createContext(req: object): object {
        return {
          req,
          get _matchedRoute(): string {
            throw new Error("a getter of the application's own");
          },
        };
      }
    };
    armContextRecording(Application.prototype, () => {});
    const req = {};
    new Application().createContext(req);
    expect(() => koaMatchedRoute(req)).not.toThrow();
    expect(koaMatchedRoute(req)).toBeUndefined();
  });
});

describe("koaRouterSawRequest", () => {
  /** A request whose context holds what a router left on it, read through the recording. */
  function requestWith(left: Record<string, unknown>): object {
    const Application = fakeApplication();
    armContextRecording(Application.prototype, () => {});
    const req = {};
    Object.assign(new Application().createContext(req, {}), left);
    return req;
  }

  it("is false for a request Koa never made a context for, and for a context no router touched", () => {
    expect(koaRouterSawRequest({})).toBe(false);
    expect(koaRouterSawRequest(requestWith({}))).toBe(false);
    expect(koaRouterSawRequest(requestWith({ _matchedRoute: "/users/:id" })), "a route with no list of layers").toBe(
      false,
    );
  });

  it("is true once a router left the layers it matched, whether or not there are any, or a route among them", () => {
    expect(koaRouterSawRequest(requestWith({ matched: [] }))).toBe(true);
    expect(koaRouterSawRequest(requestWith({ matched: [{ path: "([^/]*)", methods: [] }] }))).toBe(true);
  });

  it("is false for what is not a list of layers", () => {
    for (const matched of [undefined, null, "layers", 0, {}, true]) {
      expect(koaRouterSawRequest(requestWith({ matched })), String(matched)).toBe(false);
    }
  });

  it("is false, and throws nothing, when reading the context throws", () => {
    const Application = class {
      createContext(req: object): object {
        return {
          req,
          get matched(): unknown[] {
            throw new Error("a getter of the application's own");
          },
        };
      }
    };
    armContextRecording(Application.prototype, () => {});
    const req = {};
    new Application().createContext(req);
    expect(() => koaRouterSawRequest(req)).not.toThrow();
    expect(koaRouterSawRequest(req)).toBe(false);
  });
});

describe("armContextRecording", () => {
  it("refuses what is not a prototype with a createContext, and leaves it as it was", () => {
    const noMethod: Record<string, unknown> = { createContext: 42 };
    expect(armContextRecording(noMethod, () => {})).toBe(false);
    expect(noMethod).toEqual({ createContext: 42 });
    expect(armContextRecording({}, () => {})).toBe(false);
    expect(armContextRecording(null, () => {})).toBe(false);
    expect(armContextRecording(undefined, () => {})).toBe(false);
    expect(armContextRecording("no", () => {})).toBe(false);
    expect(armContextRecording(7, () => {})).toBe(false);
  });

  it("passes the call through: the same arguments, the same `this`, the very context it returns", () => {
    const Application = fakeApplication();
    const original = Application.prototype.createContext;
    expect(armContextRecording(Application.prototype, () => {})).toBe(true);
    expect(Application.prototype.createContext, "wrapped").not.toBe(original);
    const app = new Application();
    const req = {};
    const res = {};
    const ctx = app.createContext(req, res);
    expect(app.created, "the original ran, once, on the application's own `this`").toEqual([[req, res]]);
    expect(ctx.req).toBe(req);
    expect(ctx.res).toBe(res);
  });

  it("arms once, however many times it is asked", () => {
    const Application = fakeApplication();
    expect(armContextRecording(Application.prototype, () => {})).toBe(true);
    const wrapped = Application.prototype.createContext;
    expect(armContextRecording(Application.prototype, () => {})).toBe(false);
    expect(Application.prototype.createContext).toBe(wrapped);
    expect((Application.prototype as unknown as Record<symbol, unknown>)[MARK]).toBe(true);
    const app = new Application();
    app.createContext({}, {});
    expect(app.created, "a second agent does not run the original twice").toHaveLength(1);
  });

  it("hands a failure of the record to internalError, and the application's context still comes back", () => {
    // Koa is never given anything but a request, so the failure is made: a WeakMap takes no string for a key.
    const Application = class {
      createContext(_req: unknown): Record<string, unknown> {
        return { built: true };
      }
    };
    const failures: unknown[] = [];
    armContextRecording(Application.prototype, (err) => failures.push(err));
    let ctx: Record<string, unknown> | undefined;
    expect(() => {
      ctx = new Application().createContext("not a request");
    }).not.toThrow();
    expect(ctx, "the application got its context").toEqual({ built: true });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TypeError);
  });

  it("does not stop a real Koa from building its context, and records the one it built", () => {
    const app = new Koa();
    armContextRecording(Object.getPrototypeOf(app), () => {});
    const req = { url: "/x", headers: {} } as never;
    const ctx = app.createContext(req, {} as never) as unknown as Record<string, unknown>;
    expect(ctx.req).toBe(req);
    expect(ctx.app).toBe(app);
    (ctx as { _matchedRoute?: string })._matchedRoute = "/x/:id";
    expect(koaMatchedRoute(req)).toBe("/x/:id");
  });
});

describe("attachKoa", () => {
  /** A module cache as Node keeps it: the filename of each module, and the module, with its exports. */
  function cacheWith(files: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(files).map(([file, exports]) => [file, { exports }]));
  }

  it("wraps the Koa in the cache, wherever it is installed", () => {
    const flat = fakeApplication();
    const nested = fakeApplication();
    const pnpm = fakeApplication();
    const cache = cacheWith({
      "/app/node_modules/koa/lib/application.js": flat,
      "/app/node_modules/@strapi/core/node_modules/koa/lib/application.js": nested,
      "/app/node_modules/.pnpm/koa@2.16.4/node_modules/koa/lib/application.js": pnpm,
    });
    const armed = attachKoa({ cache, log: quiet, internalError: () => {} });
    expect(armed).toBe(3);
    for (const Application of [flat, nested, pnpm]) {
      expect((Application.prototype as unknown as Record<symbol, unknown>)[MARK]).toBe(true);
    }
  });

  it("finds the Koa on Windows, where the separator is the other one", () => {
    const win = fakeApplication();
    const cache = cacheWith({ "C:\\app\\node_modules\\koa\\lib\\application.js": win });
    expect(attachKoa({ cache, log: quiet, internalError: () => {} })).toBe(1);
  });

  it("wraps each Koa once, however many times it runs", () => {
    const Application = fakeApplication();
    const cache = cacheWith({ "/app/node_modules/koa/lib/application.js": Application });
    expect(attachKoa({ cache, log: quiet, internalError: () => {} })).toBe(1);
    const wrapped = Application.prototype.createContext;
    expect(attachKoa({ cache, log: quiet, internalError: () => {} })).toBe(0);
    expect(Application.prototype.createContext).toBe(wrapped);
  });

  it("leaves every other module alone, and the ones named like Koa that are not", () => {
    const others = [fakeApplication(), fakeApplication(), fakeApplication(), fakeApplication()];
    const [a, b, c, d] = others;
    const cache = cacheWith({
      "/app/node_modules/not-koa/lib/application.js": a,
      "/app/node_modules/koa/lib/application.mjs": b,
      "/app/node_modules/koa/lib/context.js": c,
      "/app/node_modules/koa-router/lib/application.js": d,
    });
    expect(attachKoa({ cache, log: quiet, internalError: () => {} })).toBe(0);
    for (const Application of others) {
      expect((Application.prototype as unknown as Record<symbol, unknown>)[MARK]).toBeUndefined();
    }
  });

  it("goes past an entry that is not a module, an export that is not a class, and a Koa it cannot wrap", () => {
    const good = fakeApplication();
    const cache: Record<string, unknown> = {
      "/a/node_modules/koa/lib/application.js": undefined,
      "/b/node_modules/koa/lib/application.js": null,
      "/c/node_modules/koa/lib/application.js": {},
      "/d/node_modules/koa/lib/application.js": { exports: null },
      "/e/node_modules/koa/lib/application.js": { exports: "koa" },
      "/f/node_modules/koa/lib/application.js": { exports: {} },
      "/g/node_modules/koa/lib/application.js": { exports: { prototype: {} } },
      "/h/node_modules/koa/lib/application.js": { exports: { prototype: { createContext: "not a function" } } },
      "/z/node_modules/koa/lib/application.js": { exports: good },
    };
    const failures: unknown[] = [];
    expect(attachKoa({ cache, log: quiet, internalError: (err) => failures.push(err) })).toBe(1);
    expect(failures).toEqual([]);
  });

  it("hands a cache that cannot be read to internalError, and throws nothing", () => {
    const boom = new Error("the cache cannot be listed");
    const cache = new Proxy(
      {},
      {
        ownKeys() {
          throw boom;
        },
      },
    );
    const failures: unknown[] = [];
    let armed: number | undefined;
    expect(() => {
      armed = attachKoa({ cache, log: quiet, internalError: (err) => failures.push(err) });
    }).not.toThrow();
    expect(armed).toBe(0);
    expect(failures).toEqual([boom]);
  });

  it("finds the Koa this process loaded, in the cache Node keeps", () => {
    // The real thing: `koa` was imported above, and the cache the agent reads is the one `createRequire` hands out.
    const cache = createRequire(import.meta.url).cache;
    const proto = Object.getPrototypeOf(new Koa()) as Record<symbol, unknown>;
    attachKoa({ cache, log: quiet, internalError: () => {} });
    expect(proto[MARK], "the Koa the test imported is wrapped").toBe(true);
  });
});

describe("routeOf with a Koa request", () => {
  /** A request and the context a real Koa makes for it, with the route a router would have matched on it. */
  function koaRequest(url: string, matched: string | RegExp | undefined, seen?: { router: boolean }): { url: string } {
    const app = new Koa();
    armContextRecording(Object.getPrototypeOf(app), () => {});
    const req = { url, headers: {} } as { url: string };
    const ctx = app.createContext(req as never, {} as never) as unknown as {
      _matchedRoute?: unknown;
      matched?: unknown[];
    };
    // What a router leaves before it looks for a route to run: the layers it matched, none of them a route yet.
    if (seen?.router) ctx.matched = [];
    if (matched !== undefined) ctx._matchedRoute = matched;
    return req;
  }

  it("names the route by the template the router matched, and nothing of the path travels (DT-90)", () => {
    expect(routeOf(koaRequest("/users/42", "/users/:id"))).toBe("/users/:id");
    expect(routeOf(koaRequest("/api/articles/ana-garcia-lopez?populate=*", "/api/articles/:id"))).toBe(
      "/api/articles/:id",
    );
  });

  it("makes of what the router matched a template: a leading slash, no trailing one, no doubled", () => {
    expect(routeOf(koaRequest("/x", "(.*)"))).toBe("/(.*)");
    expect(routeOf(koaRequest("/users/7", "/users/:id/"))).toBe("/users/:id");
    expect(routeOf(koaRequest("/api/users/7", "/api//users/:id"))).toBe("/api/users/:id");
    expect(routeOf(koaRequest("/", "/"))).toBe("/");
    expect(routeOf(koaRequest("/", ""))).toBe("/");
  });

  it("is the heuristic's, as it was, when there is no router at all", () => {
    expect(routeOf(koaRequest("/users/42", undefined))).toBe("/users/:id");
    expect(routeOf(koaRequest("/nope/ana@cliente.com", undefined))).toBe("/nope/:id");
  });

  it("is (unmatched) when a router saw the request and none of its routes matched (DT-56)", () => {
    expect(routeOf(koaRequest("/users/42", undefined, { router: true }))).toBe("(unmatched)");
    expect(routeOf(koaRequest("/webhook/plainsecret", undefined, { router: true }))).toBe("(unmatched)");
    // A route registered with a regular expression has matched, and has no words to be written back: the
    // same, and not the path.
    expect(routeOf(koaRequest("/users/42", /^\/users\/(\d+)$/, { router: true }))).toBe("(unmatched)");
    // And a matched route is still the route.
    expect(routeOf(koaRequest("/users/42", "/users/:id", { router: true }))).toBe("/users/:id");
  });

  it("wins over what Express says, when a Koa application is called from one", () => {
    // The same request object, which is what the record is keyed by: a copy of it would be a request Koa never saw.
    const req = Object.assign(koaRequest("/users/42", "/users/:id"), { route: { path: "*" }, baseUrl: "" });
    expect(routeOf(req)).toBe("/users/:id");
  });
});

// The routers the target user runs: the one a current application installs, and the one Strapi 5 pins.
const Router12 = createRequire(import.meta.url)("@koa/router12") as typeof Router;

describe.each([
  ["@koa/router 15", Router],
  ["@koa/router 12, the one Strapi 5 pins", Router12],
])("the template %s leaves on the context", (_name, RouterClass) => {
  /**
   * What the router left on the context of a request the application answered (`raw`), and what the agent
   * reads from it (`read`).
   */
  async function matchedBy(
    build: (app: Koa) => void,
    path: string,
  ): Promise<{ raw: string | undefined; read: string | undefined }> {
    const app = new Koa();
    armContextRecording(Object.getPrototypeOf(app), () => {});
    let seen: { _matchedRoute?: unknown; req: object } | undefined;
    app.use(async (ctx, next) => {
      seen = ctx as unknown as { _matchedRoute?: unknown; req: object };
      await next();
    });
    build(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      await res.arrayBuffer();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const raw = seen?._matchedRoute;
    return {
      raw: typeof raw === "string" ? raw : undefined,
      read: seen === undefined ? undefined : koaMatchedRoute(seen.req),
    };
  }

  it("is the path the route was registered with", async () => {
    const matched = await matchedBy((app) => {
      const router = new RouterClass();
      router.get("/users/:id", (ctx) => {
        ctx.body = "ok";
      });
      app.use(router.routes());
    }, "/users/42");
    expect(matched.raw).toBe("/users/:id");
    expect(matched.read).toBe("/users/:id");
  });

  it("has the prefix of the router and of the routers nested in it, as Strapi composes them", async () => {
    // `createAPI` + `routeManager.addRoutes` + `mount`, in the order @strapi/core 5.56 does them.
    const matched = await matchedBy((app) => {
      const root = new RouterClass();
      const api = new RouterClass({ prefix: "/api" });
      api.get("/articles", (ctx) => {
        ctx.body = "list";
      });
      api.get("/articles/:id", (ctx) => {
        ctx.body = "one";
      });
      const sub = new RouterClass({ prefix: "/pages" });
      sub.get("/:slug", (ctx) => {
        ctx.body = "page";
      });
      api.use(sub.routes(), sub.allowedMethods());
      root.use(api.routes(), api.allowedMethods());
      app.use(root.routes()).use(root.allowedMethods());
    }, "/api/articles/ana-garcia");
    expect(matched.raw).toBe("/api/articles/:id");
    expect(matched.read).toBe("/api/articles/:id");
  });

  it("has the prefix of a router mounted under another, with the parameters of both", async () => {
    const matched = await matchedBy((app) => {
      const inner = new RouterClass({ prefix: "/teams/:team" });
      inner.get("/users/:id", (ctx) => {
        ctx.body = "ok";
      });
      const outer = new RouterClass({ prefix: "/tenants/:tenant" });
      outer.use(inner.routes());
      app.use(outer.routes());
    }, "/tenants/acme-corp/teams/team-7/users/42");
    expect(matched.raw).toBe("/tenants/:tenant/teams/:team/users/:id");
    expect(matched.read).toBe("/tenants/:tenant/teams/:team/users/:id");
  });

  it("is nothing when no route matched, and the request is the heuristic's", async () => {
    const matched = await matchedBy((app) => {
      const router = new RouterClass();
      router.get("/users/:id", (ctx) => {
        ctx.body = "ok";
      });
      app.use(router.routes());
    }, "/orders/42");
    expect(matched.raw).toBeUndefined();
    expect(matched.read).toBeUndefined();
  });

  it("names the route a request handed on from, and not the middleware that ran after it", async () => {
    // The shape of Strapi's static files and 404s: the route calls `next()` and the router's path-less
    // middlewares run after it, the last one leaving its own path on the context.
    const matched = await matchedBy((app) => {
      const router = new RouterClass();
      router.get("/files/:name", async (ctx, next) => {
        await next();
        ctx.body = ctx.body ?? "a file";
      });
      router.use(async (_ctx, next) => next());
      router.use(async (_ctx, next) => next());
      app.use(router.routes());
    }, "/files/ana-garcia.pdf");
    expect(matched.raw, "what the router leaves is a middleware's path, which is why it is not read as is").not.toBe(
      "/files/:name",
    );
    expect(matched.read).toBe("/files/:name");
  });
});
