import { AsyncLocalStorage } from "node:async_hooks";

/** What one in-flight request has done so far. Counters only: never the query text, never the values. */
export interface RequestContext {
  queries: number;
  queryMs: number;
  queryMaxMs: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Opens the context for a request. Called from the `http.server.request.start` subscriber, which Node publishes
 * inside the request's own async context, so `enterWith` reaches the handler and everything it awaits. Verified
 * against concurrent keep-alive traffic: each request counts its own work.
 */
export function enterRequest(): RequestContext {
  const ctx: RequestContext = { queries: 0, queryMs: 0, queryMaxMs: 0 };
  storage.enterWith(ctx);
  return ctx;
}

/** The context of the request being served, or undefined outside one (a background job, a startup query). */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Records one finished query against the current request. Work outside a request is not attributed to any route. */
export function recordQuery(ms: number): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.queries += 1;
  ctx.queryMs += ms;
  if (ms > ctx.queryMaxMs) ctx.queryMaxMs = ms;
}
