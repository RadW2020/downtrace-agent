import diagnostics_channel from "node:diagnostics_channel";

/**
 * Fastify's route templates, read from Fastify itself.
 *
 * Without them a Fastify application was named by the heuristic over the path: `/users/42` came out as
 * `/users/:id` by luck of the digits, `/users/ana` as itself, so every user was a route of its own and its name
 * travelled (invariant 5), and a 404 sent its words. Fastify knows which route answered, and says so.
 *
 * Fastify announces every instance it creates on the channel `fastify.initialization` (Fastify 4 and 5), and only
 * when someone listens. The instrumentation listens, and adds two hooks to each instance through Fastify's own
 * API, nothing patched: `onRequest`, which keeps the template of the route that answered against the request
 * Node gave Fastify (`request.raw`, the one the instrumentation observes), and `onRoute`, which keeps what each
 * route was registered with, for `downtrace check` to name a route no test called (ESC-18). Hooks added to the
 * root are inherited by every plugin, prefixes included. An application without Fastify pays one subscription.
 *
 * An instance created before the instrumentation started is not announced to it, and keeps the heuristic; with
 * `--import` the instrumentation starts before the application loads. Nothing here throws toward the application
 * (invariant 2): a hook that cannot read what Fastify hands it records nothing and lets the request go on.
 */

const INITIALIZATION = "fastify.initialization";

/** The template of the route that answered each request, by the request Node gave Fastify. */
const templates = new WeakMap<object, string>();
/** The Fastify instance each server belongs to: a request that reached one was answered by Fastify. */
const instances = new WeakMap<object, object>();
/** What each route was registered with, by instance: `method` as Fastify keeps it (one or a list) and `url`. */
const registered = new WeakMap<object, Array<{ methods: string[]; url: string }>>();

/** The template Fastify matched the request with, as it was registered, prefixes included. */
export function fastifyMatchedRoute(req: object): string | undefined {
  return templates.get(req);
}

/** The Fastify instance whose server the request reached, or undefined when it reached none. */
export function fastifyInstanceOf(req: object): object | undefined {
  try {
    const server = (req as { socket?: { server?: unknown } }).socket?.server;
    return server !== null && typeof server === "object" ? instances.get(server) : undefined;
  } catch {
    return undefined;
  }
}

/** The routes an instance registered, as Fastify handed them to `onRoute`. Undefined for what is not one. */
export function fastifyRegistered(instance: unknown): ReadonlyArray<{ methods: string[]; url: string }> | undefined {
  return instance !== null && typeof instance === "object" ? registered.get(instance) : undefined;
}

interface FastifyLike {
  addHook(name: string, hook: (...args: unknown[]) => unknown): unknown;
  server?: unknown;
}

function isFastify(value: unknown): value is FastifyLike {
  return value !== null && typeof value === "object" && typeof (value as FastifyLike).addHook === "function";
}

function hook(fastify: FastifyLike): void {
  const routes: Array<{ methods: string[]; url: string }> = [];
  registered.set(fastify, routes);
  if (fastify.server !== null && typeof fastify.server === "object") instances.set(fastify.server, fastify);
  fastify.addHook("onRoute", (options: unknown) => {
    try {
      const { method, url } = options as { method?: unknown; url?: unknown };
      const methods = (Array.isArray(method) ? method : [method]).filter((m): m is string => typeof m === "string");
      if (typeof url === "string" && methods.length > 0) routes.push({ methods, url });
    } catch {
      // A route whose options cannot be read is one check does not name; the application registers it all the same.
    }
  });
  fastify.addHook("onRequest", (request: unknown, _reply: unknown, done: unknown) => {
    try {
      const r = request as { raw?: unknown; is404?: unknown; routeOptions?: { url?: unknown }; routerPath?: unknown };
      // The 404 handler answers what no route matched: no template, and the request is `(unmatched)`.
      if (r.is404 !== true && r.raw !== null && typeof r.raw === "object") {
        const url = r.routeOptions?.url ?? r.routerPath;
        if (typeof url === "string") templates.set(r.raw, url);
      }
    } catch {
      // The request is named as if Fastify had said nothing.
    } finally {
      if (typeof done === "function") done();
    }
  });
}

/**
 * Listens for the Fastify instances the application creates from now on. Returns what stops listening; the hooks
 * already added to an instance stay with it, and only write into the maps above.
 */
export function attachFastify(deps: { internalError: (err: unknown) => void }): () => void {
  const onInitialization = (message: unknown): void => {
    try {
      const fastify = (message as { fastify?: unknown } | null)?.fastify;
      if (isFastify(fastify)) hook(fastify);
    } catch (err) {
      deps.internalError(err);
    }
  };
  diagnostics_channel.subscribe(INITIALIZATION, onInitialization);
  return () => {
    diagnostics_channel.unsubscribe(INITIALIZATION, onInitialization);
  };
}
