import { describe, expect, it } from "vitest";
import { heuristicTemplate, normalizeMethod, routeOf } from "../src/routes.ts";

describe("routeOf", () => {
  it("prefers the Express template, including the mount path", () => {
    expect(routeOf({ url: "/products/42?x=1", route: { path: "/products/:id" }, baseUrl: "" })).toBe("/products/:id");
    expect(routeOf({ url: "/api/v1/users/7", route: { path: "/users/:id" }, baseUrl: "/api/v1" })).toBe(
      "/api/v1/users/:id",
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

  it("caps very long routes", () => {
    expect(routeOf({ url: `/${"x".repeat(1000)}` })).toHaveLength(256);
    expect(heuristicTemplate(`/${"a".repeat(1000)}`)).toBe("/:id"); // long hex looks like an id
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
