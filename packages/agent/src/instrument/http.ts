import diagnostics_channel from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { currentContext, type RequestContext, recordCallIn, recordErrorIn } from "../context.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { Logger } from "../log.ts";

/** What was known when the call started, kept until it finishes. */
interface Pending {
  ctx: RequestContext;
  started: number;
  target: string;
}

const MAX_TARGET_LENGTH = 256;

export interface InstrumentHttpDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at
   * debug, sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /**
   * Where a thrown thing becomes a signature. Absent means a failed call is counted and not identified, which
   * is what this observer did until gh-907: a failure was a number of the dependency's, and nothing more.
   */
  errors?: ErrorFingerprintCache | undefined;
}

/**
 * Observes outgoing HTTP calls, so a dependency that gets slower or starts failing can be told apart from the
 * application getting slower. Nothing is patched: `fetch` (undici) and the `node:http` client both publish on
 * `diagnostics_channel`, and this only listens.
 *
 * The response events do not necessarily run in the async context of whoever made the call, so the request's
 * context is captured when the call is created and the result is recorded into it when it ends.
 */
export function instrumentHttp(deps: InstrumentHttpDeps): () => void {
  const { log, internalError } = deps;
  const pending = new WeakMap<object, Pending>();

  const begin = (key: object | undefined, target: string): void => {
    if (!key) return;
    const ctx = currentContext();
    if (!ctx) return; // a call outside a request belongs to no endpoint
    pending.set(key, { ctx, started: performance.now(), target: clamp(target) });
  };

  const end = (key: object | undefined, status: number | undefined, failed: boolean, err?: unknown): void => {
    if (!key) return;
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    const now = performance.now();
    // A 5xx from a dependency is a failure of that dependency, the same as a connection that never answered.
    const isFailure = failed || (status ?? 0) >= 500;
    recordCallIn(p.ctx, "http", p.target, now - p.started, isFailure);
    // A failure that threw is an error beside the failed call (ERR-01); an answer, however bad, is not one,
    // because nobody threw anything and no identity is invented for it.
    recordErrorIn(p.ctx, deps.errors, isFailure, err, p.target, p.started, now);
  };

  const handlers: Array<[string, (message: unknown) => void]> = [
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
    [
      "undici:request:error",
      (message) => {
        const m = message as { request?: object; error?: unknown };
        end(m.request, undefined, true, m.error);
      },
    ],
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
    [
      "http.client.request.error",
      (message) => {
        const m = message as { request?: object; error?: unknown };
        end(m.request, undefined, true, m.error);
      },
    ],
  ];
  // Every subscriber runs behind one guard. Node calls a subscriber inside a `try` of its own and rethrows what it
  // catches on the next tick as an uncaught exception, so a throw here would end the application's process.
  // Recording is best effort, and a failure is the instrumentation's own (invariant 2, ADR 0161).
  const subscriptions = handlers.map(([name, handler]): [string, (message: unknown) => void] => [
    name,
    (message) => {
      try {
        handler(message);
      } catch (err) {
        internalError(err);
      }
    },
  ]);

  for (const [name, handler] of subscriptions) diagnostics_channel.subscribe(name, handler);
  const restoreFetch = catchFetchConnectFailures(internalError, deps.errors);
  log.debug(`observing outgoing HTTP on ${subscriptions.length} channels`);

  return () => {
    for (const [name, handler] of subscriptions) diagnostics_channel.unsubscribe(name, handler);
    restoreFetch();
  };
}

/**
 * The one place outgoing HTTP has to be touched rather than listened to.
 *
 * When a `fetch` fails to connect at all, undici publishes nothing: not `undici:request:create`, not
 * `undici:client:connectError`, nothing (measured on Node 26). That is precisely the "dependency is down" case,
 * so it cannot be left unseen. This wrapper records **only** that: if the call rejected and nothing was recorded
 * for this request while it ran, the call is counted as a failed one. On every other path it does nothing and the
 * channels above do the work, so there is no double counting.
 */
function catchFetchConnectFailures(
  internalError: (err: unknown) => void,
  errors: ErrorFingerprintCache | undefined,
): () => void {
  const original = globalThis.fetch;
  if (typeof original !== "function") return () => {};

  const wrapped: typeof fetch = async (input, init) => {
    const ctx = currentContext();
    if (!ctx) return original(input, init);
    const started = performance.now();
    const before = ctx.recorded;
    try {
      return await original(input, init);
    } catch (error) {
      // Best effort, as in the subscribers: had this thrown, the application would get our error and not its own.
      try {
        if (ctx.recorded === before) {
          // The channels said nothing, so this is the one place the call is seen: the failed call and the error
          // it threw, together, or not at all (ERR-01).
          const now = performance.now();
          const target = hostOfInput(input);
          recordCallIn(ctx, "http", target, now - started, true);
          recordErrorIn(ctx, errors, true, error, target, started, now);
        }
      } catch (failure) {
        internalError(failure);
      }
      throw error; // the application sees exactly the error it would have seen
    }
  };

  globalThis.fetch = wrapped;
  return () => {
    // Only put it back if nobody wrapped it after us.
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

function hostOfInput(input: unknown): string {
  try {
    if (typeof input === "string") return clamp(new URL(input).host);
    if (input instanceof URL) return clamp(input.host);
    if (input instanceof Request) return clamp(new URL(input.url).host);
  } catch {
    // not a URL we can read: better an unknown target than losing the call
  }
  return "unknown";
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
