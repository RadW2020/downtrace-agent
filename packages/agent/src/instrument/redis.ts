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

/**
 * Observes Redis commands. Nothing is patched: ioredis publishes on a tracing channel, so the agent subscribes to
 * the start and the end of each command and times the difference.
 *
 * The request's context is captured at the start, for the same reason as outgoing HTTP: the end of an asynchronous
 * operation does not necessarily run in the async context of whoever started it.
 */
export function instrumentRedis(log: Logger): () => void {
  const channel = diagnostics_channel.tracingChannel<CommandMessage>("ioredis:command");
  const pending = new WeakMap<object, Pending>();

  const finish = (message: CommandMessage, failed: boolean): void => {
    const p = pending.get(message as object);
    if (!p) return;
    pending.delete(message as object);
    recordCallIn(p.ctx, "redis", p.target, performance.now() - p.started, failed || message.error !== undefined);
  };

  const handlers = {
    start(message: CommandMessage) {
      const ctx = currentContext();
      if (!ctx) return; // a command outside a request belongs to no endpoint
      pending.set(message as object, { ctx, started: performance.now(), target: targetOf(message) });
    },
    asyncEnd(message: CommandMessage) {
      finish(message, false);
    },
    error(message: CommandMessage) {
      finish(message, true);
    },
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
