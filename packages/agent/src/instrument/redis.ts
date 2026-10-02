import diagnostics_channel from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import type { CallFingerprints } from "../calls.ts";
import { currentContext, type RequestContext, recordCallIn, recordErrorIn, recordOperationIn } from "../context.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { Logger } from "../log.ts";

interface Pending {
  ctx: RequestContext;
  started: number;
  target: string;
}

/**
 * What ioredis puts on its tracing channel. The server's identity and the command's name are read; never its
 * arguments, which hold the key and the values (invariant 5).
 */
interface CommandMessage {
  command?: unknown;
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
  /**
   * Where a thrown thing becomes a signature. Absent means a failed command is counted and not identified,
   * which is what this observer did until gh-907: a failure was a number of the dependency's, and nothing more.
   */
  errors?: ErrorFingerprintCache | undefined;
  /**
   * Where a command becomes an operation `command` of the request, by its name and its server (DT-17). Absent
   * means a command is counted against its dependency and is not an operation, which is what this observer did
   * before.
   */
  commands?: CallFingerprints | undefined;
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
    const now = performance.now();
    // A command the driver settles as a failure is one of the dependency's errors, the same as a call that
    // never answered.
    const isFailure = failed || message.error !== undefined;
    recordCallIn(p.ctx, "redis", p.target, now - p.started, isFailure);
    // And what it ran, by its name and its server. A message that does not say which command records no
    // operation, and the counter above stays what it was.
    const fingerprint = deps.commands?.get(message.command, p.target);
    if (fingerprint) {
      recordOperationIn(p.ctx, {
        kind: "command",
        fingerprint,
        startedAt: p.started,
        endedAt: now,
        failed: isFailure,
        target: p.target,
      });
    }
    // A failure that carried an error is an error beside the failed call (ERR-01); one that did not is not.
    recordErrorIn(p.ctx, deps.errors, isFailure, message.error, p.target, p.started, now);
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
