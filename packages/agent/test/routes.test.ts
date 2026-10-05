import express from "express";
import express4 from "express4";
import { beforeAll, describe, expect, it } from "vitest";
import { armMountRecording } from "../src/mounts.ts";
import { heuristicTemplate, normalizeMethod, routeOf } from "../src/routes.ts";

describe("routeOf", () => {
  it("prefers the Express template, and a baseUrl nobody's router explains comes out as `:param`", () => {
    expect(routeOf({ url: "/products/42?x=1", route: { path: "/products/:id" }, baseUrl: "" })).toBe("/products/:id");
    // Without the app's routers there is nothing to check the mount against, and a segment whose
    // literalness cannot be told is a parameter, not a word (invariant 5, gh-858). With the app it is
    // read as it was registered, which is the case below.
    expect(routeOf({ url: "/api/v1/users/7", route: { path: "/users/:id" }, baseUrl: "/api/v1" })).toBe(
      "/:param/:param/users/:id",
    );
    expect(routeOf({ url: "/", route: { path: "/" }, baseUrl: "" })).toBe("/");
  });

  it("falls back to the heuristic when there is no framework template", () => {
    expect(routeOf({ url: "/users/42" })).toBe("/users/:id");
    expect(routeOf({ url: "/users/7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d/orders" })).toBe("/users/:id/orders");
    expect(routeOf({ url: "/users/507f1f77bcf86cd799439011" })).toBe("/users/:id");
    expect(routeOf({ url: "/files/3f786850e387550fdab836ed7e6dc881de23001b" })).toBe("/files/:id");
    expect(routeOf({ url: "/healthz?probe=1" })).toBe("/healthz");
    expect(routeOf({ url: "/products/" })).toBe("/products");
    expect(routeOf({})).toBe("/");
    expect(routeOf({ url: "/", route: { path: 42 } })).toBe("/");
  });

  it("starts the heuristic from the path the client asked for, when Express trimmed it (gh-766)", () => {
    // The shape a mounted middleware's request has when the response finishes: `url` trimmed by the mount,
    // `originalUrl` the path the client asked for.
    expect(routeOf({ url: "/x", originalUrl: "/admin/x" })).toBe("/admin/x");
    expect(routeOf({ url: "/app.css", originalUrl: "/static/app.css" })).toBe("/static/app.css");
    // A value in any segment of the path, the prefix and all.
    expect(
      routeOf({ url: "/users/ana%40cliente.com/orders", originalUrl: "/admin/users/ana%40cliente.com/orders" }),
    ).toBe("/admin/users/:id/orders");
    expect(routeOf({ url: "/Zx8kQ2vN4pL9mR7tY3wB", originalUrl: "/admin/reset-password/Zx8kQ2vN4pL9mR7tY3wB" })).toBe(
      "/admin/reset-password/:id",
    );
    // What is not a string is not read: plain Node has no `originalUrl`, and a top-level middleware's is the
    // same as `url`, so neither of them changes what the heuristic already did.
    expect(routeOf({ url: "/users/42" })).toBe("/users/:id");
    expect(routeOf({ url: "/x", originalUrl: 42 })).toBe("/x");
    expect(routeOf({ url: "/x", originalUrl: undefined })).toBe("/x");
    expect(routeOf({ originalUrl: "/admin/x" })).toBe("/admin/x");
    // A matched route still wins, whatever the client asked for. The request keeps the mount it matched
    // (`baseUrl` and `app` at dispatch time), not the value Express restores when the router ends (gh-900).
    armMountRecording(express.Router.prototype);
    const items = express.Router();
    items.get("/items/:id", () => {});
    const adminApp = express();
    adminApp.use("/admin", items);
    const itemsRoute = items.stack[0]?.route;
    if (itemsRoute === undefined) throw new Error("the route was not registered");
    expect(
      routeOf({
        url: "/items/42",
        originalUrl: "/admin/items/42",
        route: itemsRoute,
        baseUrl: "/admin",
        app: adminApp,
      }),
    ).toBe("/admin/items/:id");
  });

  it("caps very long routes", () => {
    expect(routeOf({ url: `/${"x".repeat(1000)}` })).toHaveLength(256);
    expect(heuristicTemplate(`/${"a".repeat(1000)}`)).toBe("/:id"); // long hex looks like an id
  });

  it("folds a segment that carries a value, so the value does not leave (gh-756)", () => {
    // An email, raw and percent-encoded, and a handle with no dot after the `@`. The one a request to an
    // Express middleware answers before any route matched comes through here too: it has a url and no
    // `req.route`, which is the shape this fallback reads.
    expect(routeOf({ url: "/users/ana@cliente.com" })).toBe("/users/:id");
    expect(routeOf({ url: "/users/ana%40cliente.com/orders" })).toBe("/users/:id/orders");
    expect(routeOf({ url: "/@alice" })).toBe("/:id");
    // A token, with and without a digit in it.
    expect(routeOf({ url: "/reset-password/Zx8kQ2vN4pL9mR7tY3wB" })).toBe("/reset-password/:id");
    expect(routeOf({ url: "/reset-password/ZxkQvNpLmRtYwBqHsJdF" })).toBe("/reset-password/:id");
    // Anything that mixes letters and digits: a file name, a phone, a JWT, a provider's id.
    expect(routeOf({ url: "/files/report-2024-q3.pdf" })).toBe("/files/:id");
    expect(routeOf({ url: "/phone/+34600111222" })).toBe("/phone/:id");
    expect(routeOf({ url: "/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl" })).toBe("/verify/:id");
    expect(routeOf({ url: "/v1/customers/cus_NffrFeUfNV2Hib" })).toBe("/v1/customers/:id");
    // And a date used as a segment: a date in a path is a value, not a version.
    expect(routeOf({ url: "/reports/2024-01" })).toBe("/reports/:id");
  });

  it("keeps what is structure, and the versions that separate two endpoints", () => {
    // The digit rule takes everything with a digit in it, and the one thing a route must keep apart is a
    // version: `v1` and `v2` are two endpoints, not one.
    expect(routeOf({ url: "/api/v1/users" })).toBe("/api/v1/users");
    expect(routeOf({ url: "/api/v1.2/items" })).toBe("/api/v1.2/items");
    // A long kebab-case name is the naming convention of a route, not a value: no rule may take it.
    expect(routeOf({ url: "/api/password-reset-requests" })).toBe("/api/password-reset-requests");
    expect(routeOf({ url: "/.well-known/openid-configuration" })).toBe("/.well-known/openid-configuration");
    expect(routeOf({ url: "/blog/my-first-post-about-kubernetes" })).toBe("/blog/my-first-post-about-kubernetes");
    // And a plain word, which no rule of shape can tell from a route's own words. The README says so.
    expect(routeOf({ url: "/users/alice" })).toBe("/users/alice");
    expect(routeOf({ url: "/users/john.smith" })).toBe("/users/john.smith");
    expect(routeOf({ url: "/files/invoice.pdf" })).toBe("/files/invoice.pdf");
  });

  it("says the cost of the rules out loud", () => {
    // A technical word with a digit reads as a value, and a long camelCase name does too. They become `:id`,
    // which costs readability and merges two routes only when they differ in that segment alone; changing
    // either of these is a decision, so it is pinned here and not discovered later.
    expect(routeOf({ url: "/auth/oauth2/callback" })).toBe("/auth/:id/callback");
    expect(routeOf({ url: "/api/2fa/verify" })).toBe("/api/:id/verify");
    expect(routeOf({ url: "/storage/s3/upload" })).toBe("/storage/:id/upload");
    expect(routeOf({ url: "/api/trpc/user.getProfileWithSettings" })).toBe("/api/trpc/:id");
    expect(routeOf({ url: "/checksums/sha256" })).toBe("/checksums/:id");
  });

  it("never copies the query or the fragment, and the template wins over the heuristic", () => {
    expect(routeOf({ url: "/users?name=ana@cliente.com" })).toBe("/users");
    expect(routeOf({ url: "/users#ana@cliente.com" })).toBe("/users");
    expect(routeOf({ url: "/users/ana@cliente.com", route: { path: "/users/:id" }, baseUrl: "" })).toBe("/users/:id");
  });

  it("names an empty or separator-only path", () => {
    expect(routeOf({ url: "/" })).toBe("/");
    expect(routeOf({ url: "?name=alice" })).toBe("/");
    expect(routeOf({ url: "//" })).toBe("/");
  });
});

// Real Express (5.2.1, the package's devDependency) and real registration: the mount path is recorded
// where the application writes it, and the template is built from the routers, not from the value the
// mount matched (invariant 5, gh-858).
describe("routeOf over a real Express mount (gh-858)", () => {
  // The record is armed here and not at the import of `mounts.ts`: an import must not wrap
  // `Router.prototype.use` (gh-903), and a test that registers routes says the arm out loud.
  beforeAll(() => {
    armMountRecording(express.Router.prototype);
  });

  function mountedAt(mount: string): { app: express.Express; route: object } {
    const router = express.Router();
    router.get("/users/:id", () => {});
    const app = express();
    app.use(mount, router);
    const route = router.stack[0]?.route;
    if (route === undefined) throw new Error("the route was not registered");
    return { app, route };
  }

  it("carries a literal mount as written and a parameterised one as its pattern", () => {
    const literal = mountedAt("/api/v1");
    expect(routeOf({ url: "/api/v1/users/7", route: literal.route, baseUrl: "/api/v1", app: literal.app })).toBe(
      "/api/v1/users/:id",
    );
    const tenant = mountedAt("/tenants/:tenant");
    expect(
      routeOf({
        url: "/tenants/acme-corp/users/42",
        route: tenant.route,
        baseUrl: "/tenants/acme-corp",
        app: tenant.app,
      }),
    ).toBe("/tenants/:tenant/users/:id");
    // The same template for another tenant: what changes is the request, not the route.
    expect(
      routeOf({ url: "/tenants/otro/users/7", route: tenant.route, baseUrl: "/tenants/otro", app: tenant.app }),
    ).toBe("/tenants/:tenant/users/:id");
  });

  it("keeps a nested mount's parameter out, and says the heuristic would not have saved it", () => {
    const inner = express.Router();
    inner.get("/users/:id", () => {});
    const outer = express.Router();
    outer.use("/teams/:team", inner);
    const app = express();
    app.use("/tenants/:tenant", outer);
    const route = inner.stack[0]?.route;
    if (route === undefined) throw new Error("the route was not registered");
    const req = {
      url: "/tenants/acme-corp/teams/team-7/users/42",
      route,
      baseUrl: "/tenants/acme-corp/teams/team-7",
      app,
    };
    expect(routeOf(req)).toBe("/tenants/:tenant/teams/:team/users/:id");
    // A slug like a tenant's name passes the heuristic as it is (gh-756): the mount's pattern is the only
    // thing that keeps it out of the template, and this is what the PR says out loud.
    expect(heuristicTemplate("/tenants/acme-corp/users/42")).toBe("/tenants/acme-corp/users/:id");
  });
});

// gh-898. In Express 4 the app keeps its router on `_router`, and `router` is a getter that throws:
// `routeOf` must never let that throw out, and a read of the app's object that throws is a read the walk
// cannot trust, so it comes up as `undefined` and the `:param` fallback follows (invariant 2).
describe("an app whose router getter throws (gh-898)", () => {
  // The record armed, as in the mount describes above: what is under test is the read of the app, not
  // the recovery of the pattern.
  beforeAll(() => {
    armMountRecording(express.Router.prototype);
  });

  const throwing = (onRead?: () => void): { router: unknown; _router?: unknown } =>
    ({
      get router() {
        onRead?.();
        throw new Error("'app.router' is deprecated!");
      },
    }) as { router: unknown; _router?: unknown };

  it("reads _router first, and the throwing getter is never read", () => {
    // The shape an Express 4 app has: the router on `_router`, and a `router` getter that throws. The
    // walk reads the app whenever `baseUrl` is not empty, so this is the read a request to any mounted
    // router in an Express 4 application performs.
    const router = express.Router();
    router.get("/users/:id", () => {});
    const appRouter = express.Router();
    appRouter.use("/api", router);
    let reads = 0;
    // Object.assign, not a spread: a spread would read the getter, and reading it is the act under test.
    const app = Object.assign(
      throwing(() => (reads += 1)),
      { _router: appRouter },
    );
    expect(routeOf({ url: "/users/7", route: router.stack[0]?.route, baseUrl: "/api", app })).toBe("/api/users/:id");
    expect(reads, "the throwing getter is never read").toBe(0);
  });

  it("comes out as the :param fallback when the router cannot be read at all, and throws nothing", () => {
    expect(() =>
      routeOf({ url: "/api/v1/users/7", route: { path: "/users/:id" }, baseUrl: "/api/v1", app: throwing() }),
    ).not.toThrow();
    expect(
      routeOf({ url: "/api/v1/users/7", route: { path: "/users/:id" }, baseUrl: "/api/v1", app: throwing() }),
    ).toBe("/:param/:param/users/:id");
  });
});

describe("a mounted sub-app whose parent or mountpath throws (gh-898)", () => {
  function mountedSubApp() {
    const sub = express();
    sub.get("/users/:id", () => {});
    const root = express();
    root.use("/api", sub);
    const route = sub.router.stack[0]?.route;
    if (route === undefined) throw new Error("the route was not registered");
    return { sub, route };
  }

  function request(sub: express.Express, route: object) {
    return { url: "/users/7", route, baseUrl: "/api", app: sub };
  }

  it("says :param for the mount when the app's parent cannot be read, and throws nothing", () => {
    const { sub, route } = mountedSubApp();
    const req = request(sub, route);
    expect(routeOf(req)).toBe("/api/users/:id");
    Object.defineProperty(sub, "parent", {
      configurable: true,
      get() {
        throw new Error("parent is gone");
      },
    });
    expect(() => routeOf(req)).not.toThrow();
    expect(routeOf(req)).toBe("/:param/users/:id");
  });

  it("says :param for the mount when the app's mountpath cannot be read, and throws nothing", () => {
    const { sub, route } = mountedSubApp();
    const req = request(sub, route);
    expect(routeOf(req)).toBe("/api/users/:id");
    Object.defineProperty(sub, "mountpath", {
      configurable: true,
      get() {
        throw new Error("mountpath is gone");
      },
    });
    expect(() => routeOf(req)).not.toThrow();
    expect(routeOf(req)).toBe("/:param/users/:id");
  });
});

// Real Express 4 (4.22.3, the `express4` devDependency) and real registration: the record arms on the
// `Router` function, where `use` lives in Express 4 (gh-898), and the template is built from the record
// and the layers' own compiled matchers — never from the value a request matched (invariant 5).
describe("routeOf over a real Express 4 mount (gh-898)", () => {
  beforeAll(() => {
    armMountRecording(express4.Router);
  });

  function mountedAt(mount: string): { app: express4.Express; route: object } {
    const router = express4.Router();
    router.get("/users/:id", () => {});
    const app = express4();
    app.use(mount, router);
    const route = router.stack[0]?.route;
    if (route === undefined) throw new Error("the route was not registered");
    return { app, route };
  }

  type StackLayer = { route?: unknown; handle?: unknown; regexp?: unknown };

  it("carries a literal mount as written and a parameterised one as its pattern", () => {
    const literal = mountedAt("/api/v1");
    expect(routeOf({ url: "/api/v1/users/7", route: literal.route, baseUrl: "/api/v1", app: literal.app })).toBe(
      "/api/v1/users/:id",
    );
    const tenant = mountedAt("/tenants/:tenant");
    expect(
      routeOf({
        url: "/tenants/acme-corp/users/42",
        route: tenant.route,
        baseUrl: "/tenants/acme-corp",
        app: tenant.app,
      }),
    ).toBe("/tenants/:tenant/users/:id");
    // The same template for another tenant: what changes is the request, not the route.
    expect(
      routeOf({ url: "/tenants/otro/users/7", route: tenant.route, baseUrl: "/tenants/otro", app: tenant.app }),
    ).toBe("/tenants/:tenant/users/:id");
  });

  it("does not use a mount's matcher when it is stateful, and leaves its state as it found it (gh-898)", () => {
    for (const flag of ["g", "y"]) {
      const router = express4.Router();
      router.get("/users/:id", () => {});
      const app = express4();
      app.use("/tenants/:tenant", router);
      const route = router.stack[0]?.route;
      if (route === undefined) throw new Error("the route was not registered");

      const appStack = (app as unknown as { _router?: { stack?: StackLayer[] } })._router?.stack;
      const mount = appStack?.find((layer) => layer.route === undefined && layer.handle === router);
      if (mount === undefined || !(mount.regexp instanceof RegExp)) {
        throw new Error("the mount's compiled matcher was not found");
      }

      const stateful = new RegExp(mount.regexp.source, mount.regexp.flags + flag);
      stateful.lastIndex = 0;
      mount.regexp = stateful;

      const req = { url: "/tenants/acme-corp/users/42", route, baseUrl: "/tenants/acme-corp", app };
      let first = "";
      expect(() => {
        first = routeOf(req);
      }).not.toThrow();
      expect(first).toBe("/:param/:param/users/:id");
      expect(routeOf(req), "asking the same request twice says the same thing").toBe(first);
      expect(stateful.lastIndex, "the stateful matcher is never asked").toBe(0);
    }
  });
});

describe("routeOf when a middleware answered before any route matched (gh-899)", () => {
  beforeAll(() => {
    armMountRecording(express.Router.prototype);
  });

  type StackLayer = { route?: unknown; handle?: unknown; matchers?: unknown; regexp?: unknown };

  /** An app with one middleware under `/tenants/:tenant`, and the layer that mount is. */
  function mounted() {
    const app = express();
    app.use("/tenants/:tenant", (_req, res) => {
      res.status(401).json({});
    });
    const stack = (app.router as unknown as { stack: StackLayer[] }).stack;
    const layer = stack.find((l) => l.route === undefined && l.matchers !== undefined && l.handle !== undefined);
    if (layer === undefined) throw new Error("the mount's layer was not found");
    return { app, stack, layer };
  }

  const request = (app: unknown) => ({ url: "/users/42", baseUrl: "/tenants/acme-corp", app });

  it("names the mount by the pattern it was registered with, and the rest of the path by the heuristic", () => {
    const { app } = mounted();
    expect(routeOf(request(app))).toBe("/tenants/:tenant/users/:id");
  });

  it("is (unmatched), and not the path the client asked for, when nothing is left on baseUrl (DT-56)", () => {
    // Where an error answered by the app's handler has put `baseUrl` back to nothing, no mount is left to name,
    // and the path the client asked for carries the tenant: DT-26.
    const { app } = mounted();
    expect(
      routeOf({ url: "/tenants/acme-corp/users/42", originalUrl: "/tenants/acme-corp/users/42", baseUrl: "", app }),
    ).toBe("(unmatched)");
  });

  it("says :param for the stretch when a matcher of the mount throws, and throws nothing", () => {
    const { app, layer } = mounted();
    layer.matchers = [
      () => {
        throw new Error("the matcher is gone");
      },
    ];
    expect(() => routeOf(request(app))).not.toThrow();
    expect(routeOf(request(app))).toBe("/:param/:param/users/:id");
  });

  it("says :param for the stretch when the layer's handle cannot be read, and throws nothing", () => {
    const { app, layer } = mounted();
    Object.defineProperty(layer, "handle", {
      configurable: true,
      get() {
        throw new Error("the handle is gone");
      },
    });
    expect(() => routeOf(request(app))).not.toThrow();
    expect(routeOf(request(app))).toBe("/:param/:param/users/:id");
  });

  it("does not take the other mount's word for a stretch when one of the two cannot be read", () => {
    const { app, stack, layer } = mounted();
    app.use("/tenants/:tenant", (_req, res) => {
      res.status(401).json({});
    });
    expect(stack.length).toBeGreaterThan(1);
    Object.defineProperty(layer, "handle", {
      configurable: true,
      get() {
        throw new Error("the handle is gone");
      },
    });
    expect(() => routeOf(request(app))).not.toThrow();
    expect(routeOf(request(app))).toBe("/:param/:param/users/:id");
  });

  it("does not run the matcher of a mount registered with a regular expression that keeps state", () => {
    const stateful = /^\/ping/g;
    const app = express();
    app.use(stateful, (_req, res) => {
      res.status(200).end("pong");
    });
    stateful.lastIndex = 0;
    expect(routeOf({ url: "/x", baseUrl: "/ping", app })).toBe("/:param/x");
    expect(stateful.lastIndex, "the application's own regexp is left where it was").toBe(0);
  });

  it("says :param for the stretch when the router's stack cannot be read, and throws nothing", () => {
    const { app } = mounted();
    Object.defineProperty(app.router, "stack", {
      configurable: true,
      get() {
        throw new Error("the stack is gone");
      },
    });
    expect(() => routeOf(request(app))).not.toThrow();
    expect(routeOf(request(app))).toBe("/:param/:param/users/:id");
  });
});

// DT-56. A request that Express was answering and no route named is `(unmatched)`: the path the client asked
// for is not read at all. What Express puts on the request is what says it was Express answering, and a
// request with none of it is the heuristic's, as it was.
describe("routeOf for a request no route named (DT-56)", () => {
  const asked = { url: "/webhook/plainsecret", originalUrl: "/webhook/plainsecret" };

  it("is (unmatched) when Express was answering and nothing matched, whatever the path", () => {
    const app = express();
    for (const url of ["/webhook/plainsecret", "/.env", "/wp-login.php", "/assets/ActionPill-CwmQU5UK.js", "/"]) {
      expect(routeOf({ url, originalUrl: url, baseUrl: "", app }), url).toBe("(unmatched)");
    }
    // The same in Express 4, whose app is a function with the same `handle`.
    expect(routeOf({ ...asked, baseUrl: "", app: express4() })).toBe("(unmatched)");
  });

  it("is (unmatched) for a route that has no path to be written back, with nothing mounted", () => {
    const app = express();
    expect(routeOf({ ...asked, route: { path: /^\/webhook\/.+/ }, baseUrl: "", app })).toBe("(unmatched)");
    expect(routeOf({ ...asked, route: { path: 42 }, app })).toBe("(unmatched)");
  });

  it("is the route when a route matched, and the mount's pattern when a middleware answered under one", () => {
    const app = express();
    expect(routeOf({ ...asked, route: { path: "/webhook/*path" }, baseUrl: "", app })).toBe("/webhook/*path");
    armMountRecording(express.Router.prototype);
    const mounted = express();
    mounted.use("/tenants/:tenant", (_req, res) => {
      res.status(401).json({});
    });
    expect(
      routeOf({
        url: "/users/42",
        originalUrl: "/tenants/acme-corp/users/42",
        baseUrl: "/tenants/acme-corp",
        app: mounted,
      }),
    ).toBe("/tenants/:tenant/users/:id");
  });

  it("is the heuristic's, as it was, for a request Express did not answer", () => {
    // Plain Node: no `app` on the request, so there are no routes to have named it.
    expect(routeOf({ url: "/webhook/nope-9" })).toBe("/webhook/:id");
    expect(routeOf({ url: "/webhook/plainsecret" })).toBe("/webhook/plainsecret");
    // Whatever else sits in `app` is not an Express app: it has no `handle` to dispatch with.
    for (const app of [undefined, null, 0, "app", {}, { router: {} }, () => {}, { handle() {} }]) {
      expect(routeOf({ url: "/webhook/nope-9", app }), String(app)).toBe("/webhook/:id");
    }
  });

  it("reads nothing that throws: an `app` that cannot be read is no Express seen, and the heuristic names it", () => {
    const hostile = {
      url: "/webhook/nope-9",
      get app(): unknown {
        throw new Error("a getter of the application's own");
      },
    };
    expect(() => routeOf(hostile)).not.toThrow();
    expect(routeOf(hostile)).toBe("/webhook/:id");
    // An app whose `handle` cannot be read is the same.
    const app = Object.defineProperty(() => {}, "handle", {
      get() {
        throw new Error("no handle");
      },
    });
    expect(() => routeOf({ url: "/webhook/nope-9", app })).not.toThrow();
    expect(routeOf({ url: "/webhook/nope-9", app })).toBe("/webhook/:id");
  });
});

describe("normalizeMethod", () => {
  it("uppercases known methods and folds the rest into OTHER", () => {
    expect(normalizeMethod("get")).toBe("GET");
    expect(normalizeMethod("PATCH")).toBe("PATCH");
    expect(normalizeMethod("PROPFIND")).toBe("OTHER");
    expect(normalizeMethod(undefined)).toBe("OTHER");
  });
});
