import { createRequire } from "node:module";
import express from "express";
import express4 from "express4";
import { afterEach, describe, expect, it } from "vitest";
import { armDispatchRecording, armMountRecording, armMounts, matchedMountOf, mountPathOf } from "../src/mounts.ts";
import { express4Root } from "./support/express4-root.ts";

const MARK = Symbol.for("downtrace.mounts.use");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/**
 * gh-903, the failure half of the criteria: the arming is best effort, and a failure to arm must cost the
 * `:param` fallback and nothing else — not a throw toward the application (invariant 2), which is what
 * `Agent.start()` relies on when it arms the record.
 */
describe("armMounts", () => {
  it("does not throw when express is not resolvable from the application", () => {
    // A base that resolves nothing: the application does not use express, or it is not reachable from it.
    expect(() => armMounts("/nonexistent/no-such-application-root-903/")).not.toThrow();
  });

  it("arms the Router function of an Express 4 application, where its use lives (gh-898)", async () => {
    // The shape the record touches on Express 4: `use` on the `Router` function itself — the routers' own
    // prototype — and not on `Router.prototype`, where it is not.
    const R = express4.Router as unknown as {
      prototype: Record<PropertyKey, unknown>;
      use: (this: { stack?: unknown[] }, path: string, fn: unknown) => unknown;
    } & Record<symbol, unknown>;
    // From an application root whose express is Express 4.
    const root = await express4Root();
    cleanups.push(root.close);
    armMounts(`${root.base}/app.js`);
    expect(R.prototype[MARK], "not on the prototype").toBeUndefined();
    expect(R[MARK], "on the Router function").toBe(true);
    expect(typeof R.use, "still the method the applications call").toBe("function");
    // A router registered through it is recorded, and the wrapper passes the call through.
    const router = express4.Router();
    const middleware = (_req: unknown, _res: unknown): void => {};
    const returned = R.use.call(router, "/t/:t", middleware);
    expect(returned).toBe(router);
    const layer = (router as { stack: object[] }).stack[0];
    if (layer === undefined) throw new Error("the layer was not registered");
    expect(mountPathOf(layer)).toBe("/t/:t");
  });

  it("arms the prototype of an Express 5 application, as it always did", () => {
    // From an application root whose express is Express 5: `use` is on `Router.prototype` (router 2.x),
    // and the `Router` function itself is left as it was.
    const base = createRequire(import.meta.url).resolve("express");
    armMounts(base);
    expect(express.Router.prototype[MARK], "on the prototype").toBe(true);
    expect((express.Router as unknown as Record<symbol, unknown>)[MARK], "not on the function").toBeUndefined();
  });
});

describe("armMountRecording", () => {
  it("does not wrap a prototype whose use is not a function, and leaves it as it was", () => {
    const proto: Record<string, unknown> = { use: 42 };
    expect(armMountRecording(proto)).toBe(false);
    expect(proto).toEqual({ use: 42 });
  });

  it("refuses a prototype that is not an object or a function", () => {
    expect(armMountRecording(null)).toBe(false);
    expect(armMountRecording(undefined)).toBe(false);
    expect(armMountRecording("no")).toBe(false);
    expect(armMountRecording(7)).toBe(false);
  });

  it("records the mount path of the layers use adds, passes the call through, and arms once", () => {
    const original = function (this: { stack: unknown[] }, path: unknown, handler: unknown) {
      this.stack.push({ path, handler });
      return this;
    };
    const proto: Record<string, unknown> = { use: original };
    expect(armMountRecording(proto)).toBe(true);
    const wrapped = proto.use as typeof original;
    expect(wrapped).not.toBe(original);
    const router = { stack: [] as unknown[] };
    const middleware = (_req: unknown, _res: unknown): void => {};
    const returned = wrapped.call(router, "/tenants/:tenant", middleware);
    expect(returned).toBe(router);
    expect(router.stack).toHaveLength(1);
    expect(mountPathOf(router.stack[0] as object), "the layer keeps the path it was registered with").toBe(
      "/tenants/:tenant",
    );
    expect(armMountRecording(proto), "a second arm is a no-op").toBe(false);
    expect(proto.use).toBe(wrapped);
  });
});

describe("armDispatchRecording", () => {
  it("refuses a prototype without a dispatch function", () => {
    expect(armDispatchRecording(null)).toBe(false);
    expect(armDispatchRecording(undefined)).toBe(false);
    expect(armDispatchRecording("no")).toBe(false);
    expect(armDispatchRecording(7)).toBe(false);
    expect(armDispatchRecording({})).toBe(false);
    expect(armDispatchRecording({ dispatch: 42 })).toBe(false);
  });

  it("records the mount the dispatch saw, passes the call through, and arms once", () => {
    const calls: unknown[][] = [];
    const original = (...args: unknown[]) => {
      calls.push(args);
      return "dispatched";
    };
    const proto: Record<string, unknown> = { dispatch: original };
    expect(armDispatchRecording(proto)).toBe(true);
    const wrapped = proto.dispatch as typeof original;
    expect(wrapped, "the dispatch is wrapped").not.toBe(original);

    const req = { baseUrl: "/api", app: { name: "app" } };
    const res = {};
    const next = (): void => {};
    const result = wrapped.call({}, req, res, next);
    expect(result).toBe("dispatched");
    expect(calls).toEqual([[req, res, next]]);
    expect(matchedMountOf(req)).toEqual({ baseUrl: "/api", app: { name: "app" } });

    expect(armDispatchRecording(proto), "a second arm is a no-op").toBe(false);
    expect(proto.dispatch).toBe(wrapped);
  });

  it("lets a failed read leave the request's own values in place", () => {
    const original = (..._args: unknown[]) => "dispatched";
    const proto: Record<string, unknown> = { dispatch: original };
    expect(armDispatchRecording(proto)).toBe(true);
    const wrapped = proto.dispatch as typeof original;
    const req = {};
    Object.defineProperty(req, "baseUrl", {
      get() {
        throw new Error("the application's getter");
      },
      configurable: true,
    });

    expect(() => wrapped.call({}, req, {}, (): void => {})).not.toThrow();
    expect(matchedMountOf(req)).toBeUndefined();
  });

  it("keeps the mount of the last dispatch", () => {
    const original = (..._args: unknown[]) => "dispatched";
    const proto: Record<string, unknown> = { dispatch: original };
    expect(armDispatchRecording(proto)).toBe(true);
    const wrapped = proto.dispatch as typeof original;
    let baseUrl = "/first";
    let app = "first-app";
    const req = {
      get baseUrl() {
        return baseUrl;
      },
      get app() {
        return app;
      },
    };

    wrapped.call({}, req);
    expect(matchedMountOf(req)).toEqual({ baseUrl: "/first", app: "first-app" });

    baseUrl = "/second";
    app = "second-app";
    wrapped.call({}, req);
    expect(matchedMountOf(req), "the request's own notion of the matched route").toEqual({
      baseUrl: "/second",
      app: "second-app",
    });
  });
});
