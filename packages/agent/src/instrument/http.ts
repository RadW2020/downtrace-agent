import diagnostics_channel from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { currentContext, type RequestContext, recordCallIn } from "../context.ts";
import type { Logger } from "../log.ts";

/** What was known when the call started, kept until it finishes. */
interface Pending {
  ctx: RequestContext;
  started: number;
  target: string;
}

const MAX_TARGET_LENGTH = 256;

/**
 * Observes outgoing HTTP calls, so a dependency that gets slower or starts failing can be told apart from the
 * application getting slower. Nothing is patched: `fetch` (undici) and the `node:http` client both publish on
 * `diagnostics_channel`, and this only listens.
 *
 * The response events do not necessarily run in the async context of whoever made the call, so the request's
 * context is captured when the call is created and the result is recorded into it when it ends.
 */
export function instrumentHttp(log: Logger): () => void {
  const pending = new WeakMap<object, Pending>();

  const begin = (key: object | undefined, target: string): void => {
    if (!key) return;
    const ctx = currentContext();
    if (!ctx) return; // a call outside a request belongs to no endpoint
    pending.set(key, { ctx, started: performance.now(), target: clamp(target) });
  };

  const end = (key: object | undefined, status: number | undefined, failed: boolean): void => {
    if (!key) return;
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    // A 5xx from a dependency is a failure of that dependency, the same as a connection that never answered.
    recordCallIn(p.ctx, "http", p.target, performance.now() - p.started, failed || (status ?? 0) >= 500);
  };

  const subscriptions: Array<[string, (message: unknown) => void]> = [
    [
      "undici:request:create",
      (message) => {
        const request = (message as { request?: { origin?: unknown; [k: string]: unknown } }).request;
        begin(request, hostOf(request?.origin));
      },
    ],
    [
      "undici:request:headers",
      (message) => {
        const m = message as { request?: object; response?: { statusCode?: number } };
        end(m.request, m.response?.statusCode, false);
      },
    ],
    ["undici:request:error", (message) => end((message as { request?: object }).request, undefined, true)],
    [
      "http.client.request.start",
      (message) => {
        const request = (message as { request?: HttpClientRequest }).request;
        begin(request, hostOfClientRequest(request));
      },
    ],
    [
      "http.client.response.finish",
      (message) => {
        const m = message as { request?: object; response?: { statusCode?: number } };
        end(m.request, m.response?.statusCode, false);
      },
    ],
    ["http.client.request.error", (message) => end((message as { request?: object }).request, undefined, true)],
  ];

  for (const [name, handler] of subscriptions) diagnostics_channel.subscribe(name, handler);
  log.debug(`observing outgoing HTTP on ${subscriptions.length} channels`);

  return () => {
    for (const [name, handler] of subscriptions) diagnostics_channel.unsubscribe(name, handler);
  };
}

/** `http://api.stripe.com:443` → `api.stripe.com:443`. The scheme adds nothing to the identity of a dependency. */
function hostOf(origin: unknown): string {
  if (typeof origin === "string") {
    try {
      return new URL(origin).host || origin;
    } catch {
      return origin;
    }
  }
  if (origin && typeof origin === "object" && "host" in origin) {
    const host = (origin as { host?: unknown }).host;
    if (typeof host === "string") return host;
  }
  return "unknown";
}

interface HttpClientRequest {
  host?: unknown;
  getHeader?: (name: string) => unknown;
}

/**
 * The Host header, which carries the port for anything but 80 and 443, so a call made with the node:http client
 * lands under the same target as the same call made with `fetch`. `request.host` alone drops the port.
 */
function hostOfClientRequest(request: HttpClientRequest | undefined): string {
  const header = request?.getHeader?.("host");
  if (typeof header === "string" && header !== "") return header;
  return typeof request?.host === "string" && request.host !== "" ? request.host : "unknown";
}

function clamp(target: string): string {
  return target.length > MAX_TARGET_LENGTH ? target.slice(0, MAX_TARGET_LENGTH) : target;
}
