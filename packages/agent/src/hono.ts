import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isPromise } from "node:util/types";
import { apart, currentContext } from "./context.ts";
import type { Unannounced } from "./fastify.ts";
import type { Logger } from "./log.ts";

/**
 * Hono's route templates, and the requests a suite makes with `app.request()`, read from Hono's own routers.
 *
 * Without them a Hono application was named by the heuristic over the path, and a suite written as Hono's testing guide
 * writes it — `app.request()`, which hands the application a `Request` and never reaches Node's server — was, for
 * `downtrace check`, a run that called no route (the stranger campaign of 2026-10-29).
 *
 * Hono keeps nothing to hook on its prototype: `fetch` and `request` are fields of each instance, the dispatch is
 * private, and each router replaces its own `match` the first time it runs. What every route goes through is a router's
 * `add`, which receives the handler beside the route Hono registered it with, `[handler, { method, path }]`. It is
 * wrapped on every router Hono ships, and so is each handler a router is given: the first that runs for a request — the
 * outermost — names it by the first route it matched that is not a middleware, and opens it if Node did not announce it,
 * apart from the code that called `app.request()`, closing it when that handler settles.
 *
 * The wrappers must be in before a router is given its routes, and `new Hono()`'s router gives them at its first match,
 * the first request: so the router files are loaded at start-up, both copies (ADR 0236). Nothing here throws toward the
 * application (invariant 2): a handler that cannot be read is given to the router as it came.
 */

/** The files of the routers Hono ships, below `dist/` for the ESM copy and `dist/cjs/` for the CommonJS one. */
const ROUTER_FILES = [
  "router/reg-exp-router/router.js",
  "router/trie-router/router.js",
  "router/linear-router/router.js",
  "router/pattern-router/router.js",
];
const ROUTERS = ["RegExpRouter", "TrieRouter", "LinearRouter", "PatternRouter"];
const MARK = Symbol.for("downtrace.hono.add");

interface Route {
  method: string;
  path: string;
}

/** The template of each request, by the request Node gave `@hono/node-server`, or the one the test gave Hono. */
const templates = new WeakMap<object, string>();
/** The router whose handlers answered each request, for its routes to be declared. */
const answered = new WeakMap<object, object>();
/** What each router was given, as Hono registered it. */
const registered = new WeakMap<object, Route[]>();
/** The handlers this file wrapped: `PatternRouter` hands one to its own `add` again, for an optional parameter. */
const ours = new WeakSet<object>();
/** The contexts whose request was named: only the first handler of a request names it. */
const named = new WeakSet<object>();
/**
 * The instrumentation listening, if one is. The wrappers stay with the classes once put in, and ask for it at each
 * request: one that stopped opens nothing, and one started after it is the one they answer to.
 */
let listening: Listener | undefined;

interface Listener {
  internalError: (err: unknown) => void;
  unannounced: Unannounced | undefined;
}

/** The path of the first route the request matched that is not a middleware, as Hono registered it. */
export function honoMatchedRoute(req: object): string | undefined {
  return templates.get(req);
}

/** The router that answered the request, or undefined when Hono did not. */
export function honoRouterOf(req: object): object | undefined {
  return answered.get(req);
}

/** What a router was given, as Hono registered it. Undefined for what is not one. */
export function honoRegistered(router: unknown): ReadonlyArray<Route> | undefined {
  return router !== null && typeof router === "object" ? registered.get(router) : undefined;
}

/** `use()`: every method, and a path that ends in `*`. Not a route, and never a request's name. */
export function honoMiddleware(route: Route): boolean {
  return route.method === "ALL" && route.path.endsWith("*");
}

type Handler = (this: unknown, c: unknown, next: unknown) => unknown;

/**
 * Wraps `add` on the router classes a module of Hono exports: the ones it does not export, or exports already
 * wrapped, are left as they are. Exported for the copy Jest hands a suite.
 */
export function patchHonoRouters(exports: unknown): void {
  if (exports === null || (typeof exports !== "object" && typeof exports !== "function")) return;
  for (const name of ROUTERS) {
    const proto = (exports as Record<string, { prototype?: Record<string | symbol, unknown> } | undefined>)[name]
      ?.prototype;
    if (proto === undefined || typeof proto.add !== "function" || proto[MARK] === true) continue;
    const add = proto.add as (this: object, method: unknown, path: unknown, handler: unknown) => unknown;
    proto.add = function (this: object, method: unknown, path: unknown, handler: unknown): unknown {
      return add.call(this, method, path, wrapped(this, handler));
    };
    proto[MARK] = true;
  }
}

/** The handler a router keeps, `[handler, route]`, with the handler wrapped, and the route remembered. */
function wrapped(router: object, given: unknown): unknown {
  try {
    if (!Array.isArray(given) || ours.has(given)) return given;
    const [handler, route] = given as [unknown, unknown];
    if (typeof handler !== "function") return given;
    const { method, path } = (route ?? {}) as { method?: unknown; path?: unknown };
    if (typeof method === "string" && typeof path === "string") {
      const routes = registered.get(router) ?? [];
      registered.set(router, routes);
      routes.push({ method, path });
    }
    const tuple = [observed(handler as Handler, router), ...given.slice(1)];
    ours.add(tuple);
    return tuple;
  } catch (err) {
    listening?.internalError(err);
    return given;
  }
}

function observed(handler: Handler, router: object): Handler {
  return function (this: unknown, c: unknown, next: unknown): unknown {
    if (c === null || typeof c !== "object" || named.has(c)) return handler.call(this, c, next);
    named.add(c);
    const deps = listening;
    const doors = deps?.unannounced;
    let opened: object | undefined;
    try {
      opened = nameRequest(c, router, doors);
    } catch {
      // The request is named as if Hono had said nothing.
    }
    if (opened === undefined || deps === undefined || doors === undefined) return handler.call(this, c, next);
    const request = opened;
    // Opened apart, so the request is the context of the handlers, and not of whoever called `app.request()`.
    return apart(() => {
      try {
        doors.started(request);
      } catch (err) {
        deps.internalError(err);
        return handler.call(this, c, next);
      }
      let result: unknown;
      try {
        result = handler.call(this, c, next);
      } catch (thrown) {
        close(request, c, { thrown }, deps);
        throw thrown;
      }
      if (isPromise(result)) {
        result.then(
          (value) => close(request, c, { value }, deps),
          (thrown) => close(request, c, { thrown }, deps),
        );
      } else {
        close(request, c, { value: result }, deps);
      }
      return result;
    });
  };
}

/**
 * Names the request by the routes Hono matched, against the request Node gave `@hono/node-server` (`c.env.incoming`)
 * or, without one, the `Request` Hono was handed. Returns that request when it is one to open here: Node did not
 * announce it, and no request is being served around it.
 */
function nameRequest(c: object, router: object, doors: Unannounced | undefined): object | undefined {
  const req = (c as { req?: { raw?: unknown; matchedRoutes?: unknown } }).req;
  const incoming = (c as { env?: { incoming?: unknown } | null }).env?.incoming;
  const request = isObject(incoming) ? incoming : isObject(req?.raw) ? req.raw : undefined;
  const matched = req?.matchedRoutes;
  // A Hono that stops keeping what it matched is one that names nothing: the heuristic names its requests, as before.
  if (request === undefined || !Array.isArray(matched)) return undefined;
  answered.set(request, router);
  const template = firstRoute(matched);
  if (template !== undefined) templates.set(request, template);
  if (doors === undefined || doors.announced(request) || currentContext() !== undefined) return undefined;
  return request;
}

function firstRoute(matched: unknown[]): string | undefined {
  for (const route of matched) {
    const { method, path } = (route ?? {}) as { method?: unknown; path?: unknown };
    if (typeof method === "string" && typeof path === "string" && !honoMiddleware({ method, path })) return path;
  }
  return undefined;
}

type Outcome = { value: unknown } | { thrown: unknown };

/** Closes the request through the doors it was opened by, even if that instrumentation stopped since. */
function close(request: object, c: object, outcome: Outcome, deps: Listener): void {
  try {
    deps.unannounced?.finished(request, { statusCode: statusOf(c, outcome) });
  } catch (err) {
    deps.internalError(err);
  }
}

/**
 * The status Hono answers with: the response the handler gave, or the one kept on the context. A handler that threw is
 * answered by the application's error handler, after this and out of reach: the error's own status, for an
 * `HTTPException`, or 500, as Hono's default handler answers. And nothing at all is Hono's 404.
 */
function statusOf(c: object, outcome: Outcome): number {
  if ("thrown" in outcome) {
    const error = outcome.thrown as { status?: unknown; getResponse?: unknown } | null | undefined;
    return typeof error?.status === "number" && typeof error.getResponse === "function" ? error.status : 500;
  }
  const given = (outcome.value as { status?: unknown } | null | undefined)?.status;
  if (typeof given === "number") return given;
  const context = c as { finalized?: unknown; res?: { status?: unknown } };
  const kept = context.finalized === true ? context.res?.status : undefined;
  return typeof kept === "number" ? kept : 404;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** Whether a module Jest's sandbox requires is one of the CommonJS copy of Hono's router files. */
export function honoRouterModule(name: string, from: string): boolean {
  return name.endsWith("router.js") && from.replaceAll("\\", "/").includes("/hono/dist/cjs/");
}

export interface AttachHonoDeps {
  /** Where the application's own modules resolve from: its entry. */
  from: string;
  log: Logger;
  internalError: (err: unknown) => void;
  unannounced?: Unannounced | undefined;
}

/**
 * Loads Hono's router files, if the application can resolve Hono, and wraps them: the CommonJS copy now, the ESM one
 * when its import resolves. Returns what stops opening requests; the wrappers stay with the classes, and once stopped
 * they only name.
 */
export function attachHono(deps: AttachHonoDeps): () => void {
  const mine: Listener = { internalError: deps.internalError, unannounced: deps.unannounced };
  listening = mine;
  const root = honoRoot(deps.from);
  if (root !== undefined) {
    const require = createRequire(deps.from);
    for (const file of ROUTER_FILES) {
      try {
        patchHonoRouters(require(join(root, "dist", "cjs", file)));
      } catch (err) {
        deps.log.debug(`hono: ${file} of the CommonJS copy not loaded: ${String(err)}`);
      }
      import(pathToFileURL(join(root, "dist", file)).href).then(
        (module: unknown) => {
          try {
            patchHonoRouters(module);
          } catch (err) {
            deps.internalError(err);
          }
        },
        (err: unknown) => deps.log.debug(`hono: ${file} of the ESM copy not loaded: ${String(err)}`),
      );
    }
  }
  return () => {
    if (listening === mine) listening = undefined;
  };
}

/**
 * The directory of the Hono the application resolves, from the file its `require` resolves (`dist/cjs/index.js`), or
 * undefined when it resolves none, or one laid out otherwise.
 */
function honoRoot(from: string): string | undefined {
  try {
    const resolved = createRequire(from).resolve("hono");
    if (!resolved.endsWith(join("dist", "cjs", "index.js"))) return undefined;
    return dirname(dirname(dirname(resolved)));
  } catch {
    return undefined;
  }
}
