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
  /** The command's name as the driver said it at the start; undefined when it did not. */
  command: unknown;
}

/**
 * What ioredis and node-redis put on their tracing channels. The server's identity and the command's name are
 * read; never its arguments, which hold the key and the values (invariant 5), and which both put there.
 */
interface CommandMessage {
  command?: unknown;
  /** node-redis's batches only: `MULTI` or `PIPELINE`. */
  batchMode?: unknown;
  serverAddress?: unknown;
  serverPort?: unknown;
  error?: unknown;
}

/**
 * The channels each command is published on: ioredis's, and node-redis's from 5.12 (`redis`, `@redis/client`).
 * A node-redis older than that publishes nothing, and its commands are not seen.
 */
const COMMANDS = ["ioredis:command", "node-redis:command"] as const;
/**
 * node-redis's batches. A pipeline publishes each of its commands on `node-redis:command` as well, so only a
 * `MULTI` is taken from here: its commands are not published one by one, and the transaction is one command.
 */
const BATCHES = "node-redis:batch";

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
 * Observes Redis commands. Nothing is patched: ioredis and node-redis publish on tracing channels, so the agent
 * subscribes to the start and the end of each command and times the difference.
 *
 * The request's context is captured at the start, for the same reason as outgoing HTTP: the end of an asynchronous
 * operation does not necessarily run in the async context of whoever started it.
 */
export function instrumentRedis(deps: InstrumentRedisDeps): () => void {
  const { log, internalError } = deps;
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
    const fingerprint = deps.commands?.get(p.command, p.target);
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

  const begin = (message: CommandMessage, command: unknown): void => {
    const ctx = currentContext();
    if (!ctx) return; // a command outside a request belongs to no endpoint
    pending.set(message as object, { ctx, started: performance.now(), target: targetOf(message), command });
  };
  const ends = {
    asyncEnd: guarded((message) => finish(message, false)),
    error: guarded((message) => finish(message, true)),
  };
  const subscriptions = [
    ...COMMANDS.map((name) => ({
      channel: diagnostics_channel.tracingChannel<CommandMessage>(name),
      handlers: { start: guarded((message) => begin(message, message.command)), ...ends },
    })),
    {
      channel: diagnostics_channel.tracingChannel<CommandMessage>(BATCHES),
      handlers: {
        start: guarded((message) => {
          if (message.batchMode === "MULTI") begin(message, "MULTI");
        }),
        ...ends,
      },
    },
  ];

  for (const { channel, handlers } of subscriptions) channel.subscribe(handlers);
  log.debug("observing Redis commands");
  return () => {
    for (const { channel, handlers } of subscriptions) channel.unsubscribe(handlers);
  };
}

/** Which Redis this is, so two instances are two dependencies. Empty when the driver does not say. */
function targetOf(message: CommandMessage): string {
  const host = typeof message.serverAddress === "string" ? message.serverAddress : "";
  if (host === "") return "";
  const port = typeof message.serverPort === "number" ? message.serverPort : undefined;
  return port === undefined ? host : `${host}:${port}`;
}
