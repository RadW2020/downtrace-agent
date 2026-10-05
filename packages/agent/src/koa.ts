import type { Logger } from "./log.ts";

/**
 * The route template a Koa request matched, read off the context Koa made for it (DT-90).
 *
 * `@koa/router` — and `koa-router`, which it continues — write the path of the route that matched on the
 * context as `ctx._matchedRoute`, with the router's prefix in front of it and the mounts of the routers
 * nested in it: the template as the developer registered it, `/api/articles/:id`, never the value the
 * request carried. Strapi 5 runs on that router, so its routes come out the same way. A Koa application that
 * routes with something that does not write it has no template to read, and is named by the heuristic.
 *
 * What this module has to solve is the way to the context. The instrumentation sees the Node request, and
 * the context holds the request but nothing holds the context: Koa builds it in `createContext`, hands it to
 * the middleware and keeps no reference. So `createContext` is wrapped, and the context is remembered for as
 * long as its request lives.
 *
 * The record is a WeakMap from request to context, not a property on the request: the request is the
 * application's, and the instrumentation does not write into the application's objects (as `mounts.ts`).
 */
const contexts = new WeakMap<object, unknown>();

/**
 * The path of the route Koa's router matched for this request, as the router wrote it, or `undefined` when
 * Koa never saw the request, nothing matched, or what the router left is not a path (`koa-router` accepts a
 * regular expression, and then the matched route is the expression itself).
 *
 * `_matchedRoute` is the path of the last layer the router **ran**, and a layer that is not a route runs too:
 * a route that hands on with `next()` — Strapi's static files, its admin panel and its 404s do — is followed
 * by every middleware the router holds after it, and the last of those is what `_matchedRoute` ends as, a
 * path-less `use` named `([^/]*)` or `(?:\/|$)`. That is not the route, and it would put every one of those
 * requests under a name that says nothing. The route is the last layer with methods up to the one it names,
 * which is what Express's `req.route` is: the last route the request was dispatched to. The layers are
 * `ctx.matched`, the router's own list of what matched, in the order they run.
 *
 * A read of the context that throws is a context the template cannot be trusted from: the heuristic names
 * the request, which is the safe side (invariants 2 and 5).
 */
export function koaMatchedRoute(req: object): string | undefined {
  try {
    const ctx = contexts.get(req);
    if (ctx === null || typeof ctx !== "object") return undefined;
    const { _matchedRoute: matched, matched: layers } = ctx as { _matchedRoute?: unknown; matched?: unknown };
    if (typeof matched !== "string") return undefined;
    return routeBefore(layers, matched) ?? matched;
  } catch {
    return undefined;
  }
}

/**
 * Whether a Koa router dispatched this request: it leaves the layers it matched on the context, as an array
 * (`ctx.matched`, in `@koa/router` and in `koa-router`), before it looks for a route to run, and whether or not
 * any of them is a route. It is the sign that routes were there to name the request, so a request that has it
 * and no template is one that no route named (DT-56). A Koa application with no router leaves nothing of the
 * kind and has no routes to speak of: its requests are the heuristic's.
 *
 * A read of the context that throws is a context nothing can be said of, as in `koaMatchedRoute`: no router
 * seen, and the heuristic names the request (invariant 2).
 */
export function koaRouterSawRequest(req: object): boolean {
  try {
    const ctx = contexts.get(req);
    if (ctx === null || typeof ctx !== "object") return false;
    return Array.isArray((ctx as { matched?: unknown }).matched);
  } catch {
    return false;
  }
}

/**
 * The path of the last layer with methods — a route, not a middleware — at or before the last layer whose path
 * is `matched`. `undefined` when the router keeps no such list, or no route is in it before that layer, and
 * then `matched` stands as the router wrote it.
 */
function routeBefore(layers: unknown, matched: string): string | undefined {
  if (!Array.isArray(layers)) return undefined;
  let i = layers.length - 1;
  while (i >= 0 && pathOf(layers[i]) !== matched) i -= 1;
  for (; i >= 0; i -= 1) {
    const layer = layers[i] as { methods?: unknown } | null;
    if (Array.isArray(layer?.methods) && layer.methods.length > 0) return pathOf(layer);
  }
  return undefined;
}

function pathOf(layer: unknown): string | undefined {
  const path = (layer as { path?: unknown } | null | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

const CONTEXT_MARK = Symbol.for("downtrace.koa.context");

/** The shape of the part of Koa we touch. Anything else about the module is none of our business. */
interface ApplicationPrototype extends Record<string, unknown> {
  createContext?: unknown;
  [CONTEXT_MARK]?: boolean;
}

/**
 * Wraps `Application.prototype.createContext`, so that the context Koa builds for a request is remembered
 * under the request.
 *
 * The wrapper wraps and nothing else: the original is called with what it was called with, and what it
 * returns is returned, the same object. The record sits in a `try`, and a failure of it is the instrumentation's
 * own, handed to `internalError` and counted (invariant 2, ADR 0161); it leaves the request named by the
 * heuristic and never reaches the application.
 *
 * Idempotent: the mark keeps a second call, or a second agent, from wrapping twice.
 */
export function armContextRecording(proto: unknown, internalError: (err: unknown) => void): boolean {
  // The prototype of a class is a plain object, but a function-style `Application` is not: both count.
  if (proto === null || (typeof proto !== "object" && typeof proto !== "function")) return false;
  const target = proto as ApplicationPrototype;
  if (target[CONTEXT_MARK] === true || typeof target.createContext !== "function") return false;
  const original = target.createContext as (...args: unknown[]) => unknown;
  target.createContext = function (this: unknown, ...args: unknown[]): unknown {
    const ctx = original.apply(this, args);
    try {
      // A WeakMap takes an object for a key and throws on anything else: what Koa was not given a request
      // for is a failure of the record, counted, and the context goes back to the application all the same.
      contexts.set(args[0] as object, ctx);
    } catch (err) {
      internalError(err);
    }
    return ctx;
  };
  target[CONTEXT_MARK] = true;
  return true;
}

export interface AttachKoaDeps {
  /**
   * The module cache of the process, which is where the Koa the application loaded is. Passed in and not
   * reached for, so a test hands over one of its own.
   */
  cache: Readonly<Record<string, unknown>>;
  log: Logger;
  /** Where a failure of this module's own code goes: the agent's count of internal errors (invariant 2, ADR 0161). */
  internalError: (err: unknown) => void;
}

/** The file Koa's `main` is, from the package's directory: the same for the CommonJS and the ESM entry. */
const APPLICATION_FILES = ["/koa/lib/application.js", "\\koa\\lib\\application.js"];

/**
 * Puts the wrapper on every Koa the application has loaded, and returns how many it found.
 *
 * Koa is found in the module cache and not resolved from the application's root, because the application
 * usually has no name to resolve it by: Strapi brings its own Koa, and under pnpm that Koa is not reachable
 * from the application at all. What the cache holds is the Koa that is loaded, wherever it is installed, and
 * the module an `import` of the ESM entry loads as well, because that entry is a wrapper over the same file.
 * Every copy is wrapped, and each is wrapped once (`armContextRecording`).
 *
 * It does not load anything, which is the point of ADR 0209: a tracker that instruments Koa by hooking the
 * module's load would never see a Koa this observer had loaded first. So it runs from the start of the first
 * request, when the application has loaded its modules (a server that answers a request has finished its
 * start-up) and before the handler that creates the context runs. A Koa loaded later than that — a lazy
 * `import()` after the first request — is not seen, and its requests are named by the heuristic.
 *
 * Reading the cache is a loop over memory, not I/O (invariant 1), and it happens once per process: the cost
 * that matters, per request, is the wrapper's, and an application without Koa pays none.
 *
 * It cannot throw (invariant 2): a cache that cannot be read is Koa not found.
 */
export function attachKoa(deps: AttachKoaDeps): number {
  let armed = 0;
  try {
    for (const file of Object.keys(deps.cache)) {
      if (!APPLICATION_FILES.some((suffix) => file.endsWith(suffix))) continue;
      const exported = (deps.cache[file] as { exports?: unknown } | undefined)?.exports;
      const proto = (exported as { prototype?: unknown } | undefined)?.prototype;
      if (armContextRecording(proto, deps.internalError)) {
        armed += 1;
        deps.log.debug(`recording the route templates of the Koa at ${file}`);
      }
    }
  } catch (err) {
    deps.internalError(err);
  }
  return armed;
}
