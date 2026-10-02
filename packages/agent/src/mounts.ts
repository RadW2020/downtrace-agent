import { createRequire } from "node:module";
import { applicationEntry } from "./entry.ts";

/**
 * The mount path a layer was registered with, kept from the moment of registration until the process ends.
 *
 * Why it has to be recorded here rather than read at request time: Express compiles the path of
 * `app.use("/tenants/:tenant", router)` into a matcher at registration and leaves on the layer what the
 * request matched — the value, per request, overwritten by the next one — in Express 4 (router 1.x) as
 * `path`, and in Express 5 (router 2.x) as well. At request time the pattern exists only where this
 * module put it, and reading the value for the pattern is the leak the record exists to close
 * (invariant 5, gh-898).
 *
 * The record is a WeakMap from layer to path, not a property on the layer: the layers are the
 * application's, and the instrumentation does not write into the application's objects.
 */
const mountPaths = new WeakMap<object, unknown>();

/** What a layer was mounted with, recorded at registration. `undefined` when it was not recorded. */
export function mountPathOf(layer: object): unknown {
  return mountPaths.get(layer);
}

/** The mount a matched route saw at dispatch time, kept until the request can be garbage-collected. */
export interface MatchedMount {
  baseUrl: unknown;
  app: unknown;
}

const matchedMounts = new WeakMap<object, MatchedMount>();

/** What the last matched route of the request saw. `undefined` when no dispatch was recorded. */
export function matchedMountOf(req: object): MatchedMount | undefined {
  return matchedMounts.get(req);
}

const USE_MARK = Symbol.for("downtrace.mounts.use");

/** The shape of the part of Express we touch. Anything else about the module is none of our business. */
interface RouterPrototype extends Record<string, unknown> {
  use?: unknown;
  [USE_MARK]?: boolean;
}

/**
 * Wraps the `use` the routers call, so that the layers an application registers are recorded with the
 * path they were registered with.
 *
 * The wrapper wraps and nothing else: the original is called with what it was called with, and what it
 * returns is returned; the record sits in a `try` no request will ever see. A failure here degrades the
 * mounted routes to the `:param` fallback in `routes.ts` (invariant 5); it never reaches the application
 * (invariant 2).
 *
 * Idempotent: the mark keeps a second call, or a second agent, from wrapping twice.
 */
export function armMountRecording(proto: unknown): boolean {
  // The prototype is a function in router 2.x (`Router.prototype = function () {}`), so both shapes count.
  if (proto === null || (typeof proto !== "object" && typeof proto !== "function")) return false;
  const target = proto as RouterPrototype;
  if (target[USE_MARK] === true || typeof target.use !== "function") return false;
  const original = target.use;
  target.use = function (this: { stack?: unknown[] }, ...args: unknown[]): unknown {
    const stack = this.stack;
    const before = Array.isArray(stack) ? stack.length : -1;
    const result = (original as (...a: unknown[]) => unknown).apply(this, args);
    try {
      if (before >= 0 && Array.isArray(stack)) {
        // The path `use` itself computes: a first argument that is a function means the mount is `/`.
        const path = typeof args[0] === "function" ? "/" : args[0];
        for (let i = before; i < stack.length; i += 1) mountPaths.set(stack[i] as object, path);
      }
    } catch {
      // The record is best effort; a failure leaves the `:param` fallback in place.
    }
    return result;
  };
  target[USE_MARK] = true;
  return true;
}

const DISPATCH_MARK = Symbol.for("downtrace.mounts.dispatch");

/** The shape of the part of Express we touch. Anything else about the module is none of our business. */
interface RoutePrototype extends Record<string, unknown> {
  dispatch?: unknown;
  [DISPATCH_MARK]?: boolean;
}

/**
 * Wraps `Route.prototype.dispatch`, so that the mount a matched route saw is recorded on the request while
 * the route is still dispatching, before the router restores the request's `baseUrl` (or, for a sub-app,
 * its `app`).
 *
 * The wrapper wraps and nothing else: the record sits in a `try` no request will ever see, and the original
 * is called with what it was called with. A failure here degrades the route to the values the request still
 * carries at response time (invariant 5); it never reaches the application (invariant 2).
 *
 * The last dispatch wins, which is the request's own notion of the matched route. Idempotent: the mark keeps
 * a second call, or a second agent, from wrapping twice.
 */
export function armDispatchRecording(proto: unknown): boolean {
  if (proto === null || (typeof proto !== "object" && typeof proto !== "function")) return false;
  const target = proto as RoutePrototype;
  if (target[DISPATCH_MARK] === true || typeof target.dispatch !== "function") return false;
  const original = target.dispatch;
  target.dispatch = function (this: unknown, ...args: unknown[]): unknown {
    const req = args[0];
    try {
      if (req !== null && typeof req === "object") {
        const request = req as Record<string, unknown>;
        matchedMounts.set(req, { baseUrl: request.baseUrl, app: request.app });
      }
    } catch {
      // The record is best effort; a failure leaves the request's own values in place.
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  target[DISPATCH_MARK] = true;
  return true;
}

/**
 * Resolves the express the application uses and arms the record on the `use` its routers call.
 *
 * It runs from `Agent.start()` and not at the load of this module: an import of the package must not load
 * express or wrap a method of it when the instrumentation is not starting (the README's promise, gh-903),
 * and `register` calls `start()` during `--import`, before the application registers anything, so no pattern
 * is lost. It is still not deferred to the first request: the pattern is discarded at the moment the route is
 * registered, and there is no later moment from which it can be recovered. `armPg` can defer its patch
 * (ADR 0209) because a query cannot run before the driver is loaded; a mount registered before the record is
 * armed cannot be read after.
 *
 * Resolving loads express into the module cache before the application loads it; that is deliberate — the
 * prototype that gets patched is the one the application will use, whatever the order of the loads.
 *
 * Where `use` lives is the express's business, and the two supported ones keep it apart (gh-898): router
 * 2.x, the one Express 5 ships, on `Router.prototype`, and router 1.x, the one Express 4 ships, on the
 * `Router` function itself — the routers' own prototype, the one their instances inherit from. One of the
 * two has it, the mark keeps the record from being armed twice, and a `Router` without either leaves the
 * application as it was.
 *
 * Express is resolved from `from`, the application's entry as Node runs it: the start passes the one it
 * resolved with the process's own flags, and absent it is `applicationEntry()`, Node's default — the realpath,
 * not the symlinked binary the process may have been started through (DT-34).
 *
 * Best effort: no express, or an express that is not resolvable from the application's root, leaves the
 * `:param` fallback in place, which is the safe side (invariant 5). It cannot throw, and `start()` relies on
 * that (invariant 2).
 */
export function armMounts(from?: string): void {
  try {
    const express = createRequire(from ?? applicationEntry())("express") as {
      Router?: { prototype?: unknown };
      Route?: { prototype?: unknown };
    };
    armMountRecording(express.Router?.prototype) || armMountRecording(express.Router);
    armDispatchRecording(express.Route?.prototype);
  } catch {
    // The application does not use express, or it is not resolvable from here.
  }
}
