import express from "express";
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
    // A matched route still wins, whatever the client asked for.
    expect(
      routeOf({ url: "/items/42", originalUrl: "/admin/items/42", route: { path: "/items/:id" }, baseUrl: "" }),
    ).toBe("/items/:id");
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

describe("normalizeMethod", () => {
  it("uppercases known methods and folds the rest into OTHER", () => {
    expect(normalizeMethod("get")).toBe("GET");
    expect(normalizeMethod("PATCH")).toBe("PATCH");
    expect(normalizeMethod("PROPFIND")).toBe("OTHER");
    expect(normalizeMethod(undefined)).toBe("OTHER");
  });
});
