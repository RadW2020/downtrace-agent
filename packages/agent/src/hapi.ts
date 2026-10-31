import diagnostics_channel from "node:diagnostics_channel";
import { createRequire } from "node:module";
import path from "node:path";
import { apart, currentContext } from "./context.ts";
import { basesOf, type From } from "./entry.ts";
import type { Unannounced } from "./fastify.ts";

/**
 * Hapi's route templates, and the requests a suite makes with `server.inject()`, read from Hapi's own request.
 *
 * Without them a Hapi application was named by the heuristic over the path: `/users/42` as `/users/:id` by luck of the
 * digits, `/users/ana` as itself. Hapi routes a request in `Request.prototype._lookup`, which leaves on the request the
 * route it matched, whose `path` is the template the application registered, a plugin's prefix included
 * (`/api/orders/{id?}`); a request no route matched gets Hapi's own `notFound`, which is `(unmatched)` here. The name
 * keeps Hapi's braces, as Next.js's keeps its brackets: it is the template the code was written with.
 *
 * `server.inject()` — how Hapi's own tests, and Lab's, call an application — hands Hapi a request of Shot's and never
 * reaches Node's server, so Node announces nothing of it. `Request.prototype._execute`, which runs the whole lifecycle of
 * every request, opens one Node did not announce through the same doors Fastify's `inject()` goes through, apart from
 * the code that injected it, and closes it when Shot's response finishes.
 *
 * The class is not exported, and a suite that only injects never makes a request Node announces, at which a patch
 * could go in: so it is patched as Hapi loads it (`attachHapi`), before any request. Nothing here throws toward the
 * application (invariant 2).
 */

const MARK = Symbol.for("downtrace.hapi.instrumented");

/** The template of each request Hapi routed, by the request Node gave it or the one Shot made. */
const templates = new WeakMap<object, string>();
/** The requests Hapi answered with its `notFound`: no route matched, and nothing of the path travels. */
const unmatched = new WeakSet<object>();
/** The router of the server that routed each request, matched or not, for its routes to be declared (ESC-18). */
const routers = new WeakMap<object, object>();
/** The routers this file has seen route a request: only those are read as Hapi's. */
const known = new WeakSet<object>();

interface Listener {
  internalError: (err: unknown) => void;
  unannounced: Unannounced | undefined;
}

/**
 * The instrumentation listening, if one is. The wrappers stay with the class once put in, and ask for it at each
 * request: one that stopped opens nothing, and one started after it is the one they answer to.
 */
let listening: Listener | undefined;

/** The template Hapi matched for a request, braces and prefix as Hapi registered it. */
export function hapiMatchedRoute(req: object): string | undefined {
  return templates.get(req);
}

/** Whether Hapi answered the request with no route of the application's: then it is `(unmatched)`. */
export function hapiUnmatched(req: object): boolean {
  return unmatched.has(req);
}

/**
 * The router of the Hapi server that routed the request, or undefined when Hapi did not. One per server: a plugin's
 * routes, prefix included, are in its server's router.
 */
export function hapiRouterOf(req: object): object | undefined {
  return routers.get(req);
}

/**
 * The routes a Hapi router holds, `method` as Hapi keeps it (lower case, `*` for every method) and `path` the template
 * a request to it is named by, read from the router when asked: a route registered after the server answered is
 * there too. Undefined for what is not a router this file saw route a request, and empty for one that cannot be read
 * (invariant 2).
 */
export function hapiRegistered(router: unknown): ReadonlyArray<{ method: string; path: string }> | undefined {
  if (router === null || typeof router !== "object" || !known.has(router)) return undefined;
  try {
    const table = (router as { table?: unknown }).table;
    if (typeof table !== "function") return [];
    const routes: unknown = table.call(router);
    if (!Array.isArray(routes)) return [];
    const out: Array<{ method: string; path: string }> = [];
    for (const route of routes) {
      const { method, path } = (route ?? {}) as { method?: unknown; path?: unknown };
      if (typeof method === "string" && typeof path === "string") out.push({ method, path });
    }
    return out;
  } catch {
    return [];
  }
}

interface HapiRequest {
  raw?: { req?: unknown; res?: unknown };
  route?: { path?: unknown };
  _route?: unknown;
  _core?: { router?: { specials?: { notFound?: { route?: unknown } } } };
}

interface Proto extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
}

/** Wraps `_lookup` and `_execute` of Hapi's `Request` class. Returns whether there was one to wrap. */
export function patchHapiRequest(Request: unknown): boolean {
  const proto = (Request as { prototype?: Proto } | null | undefined)?.prototype;
  if (proto?.[MARK] === true) return true;
  if (!proto || typeof proto._lookup !== "function" || typeof proto._execute !== "function") return false;
  const lookup = proto._lookup as (...args: unknown[]) => unknown;
  proto._lookup = function (this: HapiRequest, ...args: unknown[]): unknown {
    const result = lookup.apply(this, args);
    try {
      remember(this);
    } catch (err) {
      listening?.internalError(err);
    }
    return result;
  };
  const execute = proto._execute as (...args: unknown[]) => unknown;
  proto._execute = function (this: HapiRequest, ...args: unknown[]): unknown {
    const deps = listening;
    let request: object | undefined;
    try {
      request = unannounced(this, deps);
    } catch (err) {
      deps?.internalError(err);
    }
    if (request === undefined || deps === undefined) return execute.apply(this, args);
    return opened(this, request, deps, () => execute.apply(this, args));
  };
  proto[MARK] = true;
  return true;
}

/**
 * Keeps the template the request matched, or that it matched none, against the request Node or Shot gave Hapi, and the
 * router of the server that routed it.
 */
function remember(hapi: HapiRequest): void {
  const req = hapi.raw?.req;
  if (req === null || typeof req !== "object") return;
  const router = hapi._core?.router;
  if (router !== null && typeof router === "object") {
    routers.set(req, router);
    known.add(router);
  }
  const notFound = router?.specials?.notFound?.route;
  if (notFound !== undefined && hapi._route === notFound) {
    unmatched.add(req);
    return;
  }
  const template = hapi.route?.path;
  if (typeof template === "string") templates.set(req, template);
}

/** The request to open here: one Node did not announce, outside any request being served. */
function unannounced(hapi: HapiRequest, deps: Listener | undefined): object | undefined {
  const doors = deps?.unannounced;
  const req = hapi.raw?.req;
  if (doors === undefined || req === null || typeof req !== "object") return undefined;
  if (doors.announced(req) || currentContext() !== undefined) return undefined;
  return req;
}

/**
 * Runs the lifecycle in a request of its own, apart from the code that injected it, and closes the request when the
 * response Shot made finishes: with the status Hapi gave it, which is what Shot hands the test.
 */
function opened(hapi: HapiRequest, request: object, deps: Listener, lifecycle: () => unknown): unknown {
  return apart(() => {
    const doors = deps.unannounced;
    if (doors === undefined) return lifecycle();
    try {
      doors.started(request);
    } catch (err) {
      deps.internalError(err);
      return lifecycle();
    }
    const res = hapi.raw?.res as { once?: unknown; statusCode?: unknown } | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        doors.finished(request, { statusCode: typeof res?.statusCode === "number" ? res.statusCode : 500 });
      } catch (err) {
        deps.internalError(err);
      }
    };
    if (typeof res?.once === "function") {
      res.once.call(res, "finish", close);
      res.once.call(res, "close", close);
    }
    return lifecycle();
  });
}

export interface AttachHapiDeps {
  /** Where the application's own modules resolve from: its entry, and under `check` its project. */
  from: From;
  internalError: (err: unknown) => void;
  unannounced?: Unannounced | undefined;
}

/** Whether a file is the module of Hapi's `Request` class: `lib/request.js` of `@hapi/hapi`. */
function isHapiRequest(file: string): boolean {
  return file.replaceAll("\\", "/").endsWith("/@hapi/hapi/lib/request.js");
}

/**
 * Patches Hapi's `Request` as Hapi loads it, and at once a Hapi the application loaded already. Hapi's own modules
 * require it by a relative name, through `require`, whether the application imported Hapi or required it — which Node
 * announces on its `module.require` channel, from Node 22; an application's `import` of Hapi itself is not announced.
 * Returns what stops opening requests; the wrappers stay with the class, and once stopped they only name.
 */
export function attachHapi(deps: AttachHapiDeps): () => void {
  const mine: Listener = { internalError: deps.internalError, unannounced: deps.unannounced };
  listening = mine;
  for (const base of basesOf(deps.from)) {
    try {
      const require = createRequire(base);
      const loaded = require.cache[path.join(path.dirname(require.resolve("@hapi/hapi")), "request.js")];
      if (loaded !== undefined) patchHapiRequest(loaded.exports);
    } catch {
      // Most applications do not have Hapi.
    }
  }
  const channel = diagnostics_channel.tracingChannel("module.require");
  const handlers = {
    start: () => {},
    end: (message: unknown) => {
      const { id, parentFilename, result } = message as { id?: unknown; parentFilename?: unknown; result?: unknown };
      // One comparison for every module the process loads, at load, and nothing in a request.
      if (id !== "./request" || typeof parentFilename !== "string") return;
      if (!isHapiRequest(path.join(path.dirname(parentFilename), "request.js"))) return;
      try {
        patchHapiRequest(result);
      } catch (err) {
        deps.internalError(err);
      }
    },
    asyncStart: () => {},
    asyncEnd: () => {},
    error: () => {},
  };
  channel.subscribe(handlers);
  return () => {
    channel.unsubscribe(handlers);
    if (listening === mine) listening = undefined;
  };
}
