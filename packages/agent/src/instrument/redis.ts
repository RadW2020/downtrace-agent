import diagnostics_channel from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { currentContext, type RequestContext, recordCallIn } from "../context.ts";
import type { Logger } from "../log.ts";

interface Pending {
  ctx: RequestContext;
  started: number;
  target: string;
}

/** What ioredis puts on its tracing channel. Only the server's identity is read; never the command's arguments. */
interface CommandMessage {
  serverAddress?: unknown;
  serverPort?: unknown;
  error?: unknown;
}

export interface InstrumentRedisDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at
   * debug, sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
}

/**
 * Observes Redis commands. Nothing is patched: ioredis publishes on a tracing channel, so the agent subscribes to
 * the start and the end of each command and times the difference.
 *
 * The request's context is captured at the start, for the same reason as outgoing HTTP: the end of an asynchronous
 * operation does not necessarily run in the async context of whoever started it.
 */
export function instrumentRedis(deps: InstrumentRedisDeps): () => void {
  const { log, internalError } = deps;
  const channel = diagnostics_channel.tracingChannel<CommandMessage>("ioredis:command");
  const pending = new WeakMap<object, Pending>();

  const finish = (message: CommandMessage, failed: boolean): void => {
    const p = pending.get(message as object);
    if (!p) return;
    pending.delete(message as object);
    recordCallIn(p.ctx, "redis", p.target, performance.now() - p.started, failed || message.error !== undefined);
  };

  // Every handler runs behind one guard, for the same reason as outgoing HTTP's: Node rethrows a subscriber's throw
  // on the next tick as an uncaught exception, which ends the application's process (invariant 2, ADR 0161).
  const guarded =
    (handler: (message: CommandMessage) => void) =>
    (message: CommandMessage): void => {
      try {
        handler(message);
      } catch (err) {
        internalError(err);
      }
    };

  const handlers = {
    start: guarded((message) => {
      const ctx = currentContext();
      if (!ctx) return; // a command outside a request belongs to no endpoint
      pending.set(message as object, { ctx, started: performance.now(), target: targetOf(message) });
    }),
    asyncEnd: guarded((message) => finish(message, false)),
    error: guarded((message) => finish(message, true)),
  };

  channel.subscribe(handlers);
  log.debug("observing Redis commands");
  return () => channel.unsubscribe(handlers);
}

/** Which Redis this is, so two instances are two dependencies. Empty when the driver does not say. */
function targetOf(message: CommandMessage): string {
  const host = typeof message.serverAddress === "string" ? message.serverAddress : "";
  if (host === "") return "";
  const port = typeof message.serverPort === "number" ? message.serverPort : undefined;
  return port === undefined ? host : `${host}:${port}`;
}
