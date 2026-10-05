import { describe, expect, it } from "vitest";
import { nextMatchedPathname } from "../src/next.ts";
import { routeOf } from "../src/routes.ts";

/** The symbol Next writes the meta of a request under; `Symbol.for`, so the test's is the application's. */
const META = Symbol.for("NextInternalRequestMeta");

/** A request as Next 14 to 16 leave it: the match of the route table under `match`. */
function nextRequest(url: string, pathname: string): Record<symbol | string, unknown> {
  return { url, [META]: { match: { definition: { kind: "APP_ROUTE", pathname, page: `${pathname}/route` } } } };
}

/**
 * DT-90. Next serves its routes from files, and says which file a request matched on the request itself. The
 * shapes below are the ones read off Next 13.5, 14.2, 15.5 and 16.3 running `next start` and, on 16.3,
 * `output: "standalone"`; the README lists them. Next documents none of it, so every way the shape can be
 * different is a request that is named by the heuristic and not a throw.
 */
describe("nextMatchedPathname", () => {
  it("reads the pathname of the route Next matched, as the file system names it", () => {
    expect(nextMatchedPathname(nextRequest("/api/products/7", "/api/products/[id]"))).toBe("/api/products/[id]");
    expect(nextMatchedPathname(nextRequest("/api/files/a/b", "/api/files/[...path]"))).toBe("/api/files/[...path]");
    expect(nextMatchedPathname(nextRequest("/docs", "/docs/[[...slug]]"))).toBe("/docs/[[...slug]]");
    expect(nextMatchedPathname(nextRequest("/", "/"))).toBe("/");
  });

  it("reads Next 13, which keeps the match under another name", () => {
    const req = { url: "/api/products/7", [META]: { _nextMatch: { definition: { pathname: "/api/products/[id]" } } } };
    expect(nextMatchedPathname(req)).toBe("/api/products/[id]");
  });

  it("reads the name Next gives a path no route matched, which says nothing of the path", () => {
    expect(nextMatchedPathname(nextRequest("/nope/ana@cliente.com", "/_not-found"))).toBe("/_not-found");
  });

  it("is nothing for a request Next never saw", () => {
    expect(nextMatchedPathname({ url: "/users/42" })).toBeUndefined();
    expect(nextMatchedPathname({})).toBeUndefined();
  });

  it("is nothing for a request Next saw and did not route", () => {
    // What `/_next/static` answers before the route table: the meta is there, the match is not (Next 15, 16).
    expect(
      nextMatchedPathname({ url: "/_next/static/a.js", [META]: { initURL: "/_next/static/a.js" } }),
    ).toBeUndefined();
  });

  it("is nothing for a meta or a match that is not the shape read", () => {
    const shapes: unknown[] = [
      null,
      "match",
      42,
      {},
      { match: null },
      { match: "/api/products/[id]" },
      { match: {} },
      { match: { definition: null } },
      { match: { definition: "/api/products/[id]" } },
      { match: { definition: {} } },
      { match: { definition: { pathname: 7 } } },
      { match: { definition: { pathname: ["/api/products/[id]"] } } },
      // A template begins with `/` (ADR 0104); what does not is not one, and `joinTemplate` would invent it.
      { match: { definition: { pathname: "api/products/[id]" } } },
      { match: { definition: { pathname: "" } } },
    ];
    for (const meta of shapes) {
      expect(nextMatchedPathname({ url: "/x", [META]: meta }), JSON.stringify(meta)).toBeUndefined();
    }
  });

  it("is nothing, and throws nothing, when reading the meta throws", () => {
    const hostile = { url: "/x" };
    Object.defineProperty(hostile, META, {
      get() {
        throw new Error("a getter of the application's own");
      },
    });
    expect(() => nextMatchedPathname(hostile)).not.toThrow();
    expect(nextMatchedPathname(hostile)).toBeUndefined();

    const definitionThrows = {
      url: "/x",
      [META]: {
        match: {
          get definition() {
            throw new Error("a getter");
          },
        },
      },
    };
    expect(nextMatchedPathname(definitionThrows)).toBeUndefined();
  });
});

describe("routeOf with a Next.js request", () => {
  it("names the route by its template, and nothing of the path travels (DT-90)", () => {
    const seven = routeOf(nextRequest("/api/products/7", "/api/products/[id]"));
    const eight = routeOf(nextRequest("/api/products/8?color=red", "/api/products/[id]"));
    expect(seven).toBe("/api/products/[id]");
    expect(eight, "one route for both").toBe(seven);
    // What the heuristic leaves as written, because it cannot tell a slug from a word, is a parameter here.
    expect(routeOf(nextRequest("/blog/ana-garcia-lopez", "/blog/[slug]"))).toBe("/blog/[slug]");
    expect(routeOf(nextRequest("/shop/shoes/nike", "/shop/[category]/[brand]"))).toBe("/shop/[category]/[brand]");
  });

  it("names a path no route matched by Next's own name for it", () => {
    expect(routeOf(nextRequest("/wp-admin/ana-garcia", "/_not-found"))).toBe("/_not-found");
  });

  it("is the heuristic's, as it was, for a request with no match", () => {
    const unrouted = { url: "/_next/static/chunks/main-app-3f2a1b.js", [META]: { initURL: "x" } };
    expect(routeOf(unrouted)).toBe("/_next/static/chunks/:id");
    expect(routeOf({ url: "/users/42" })).toBe("/users/:id");
  });

  it("wins over what Express says when Next sits behind an Express server", () => {
    // Next's custom server: Express routes everything to Next's handler, and the route Express matched is a
    // catch-all. Next's is the one that names the request.
    const req = {
      ...nextRequest("/api/products/7", "/api/products/[id]"),
      route: { path: "*" },
      baseUrl: "",
    };
    expect(routeOf(req)).toBe("/api/products/[id]");
  });

  it("caps a very long pathname, as any template", () => {
    expect(routeOf(nextRequest("/x", `/${"[a]/".repeat(200)}`))).toHaveLength(256);
  });
});
