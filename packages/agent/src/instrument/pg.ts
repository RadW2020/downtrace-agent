import { AsyncResource } from "node:async_hooks";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import {
  currentContext,
  type RequestContext,
  recordCall,
  recordCallIn,
  recordOperationIn,
  recordWait,
  recordWaitIn,
} from "../context.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { FingerprintCache } from "../fingerprint.ts";
import type { Logger } from "../log.ts";

/** `pg` takes the query as a string or as a config object; anything else is not a query text we can read. */
function queryTextOf(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first !== null && typeof first === "object") {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

const MARK = Symbol.for("downtrace.pg.instrumented");
const WAIT_MARK = Symbol.for("downtrace.pg.pool.instrumented");

/** Shape of the part of `pg` we touch. Anything else about the module is none of our business. */
interface PgProto extends Record<string, unknown> {
  [MARK]?: boolean;
  [WAIT_MARK]?: boolean;
}

interface PgModule {
  Client?: { prototype?: PgProto };
  Pool?: { prototype?: PgProto };
}

export interface InstrumentPgDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at
   * debug, sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /**
   * Where the query text becomes a fingerprint. Absent means no profile is being built, and then the text is
   * never even looked at: the cost of normalising is not paid by an agent that would not send it.
   */
  fingerprints?: FingerprintCache | undefined;
  /**
   * Where a thrown thing becomes a signature. Absent means errors are counted and not identified, which is
   * what this instrumentation did until gh-338.
   */
  errors?: ErrorFingerprintCache | undefined;
  /** Resolution base; defaults to the application's entry point, then its working directory. */
  from?: string | undefined;
  /** Injected in tests instead of resolving the real module. */
  moduleImpl?: unknown;
}

/**
 * Wraps `pg`'s `Client.prototype.query` so every query counts towards the request that issued it.
 *
 * The agent loads before the application (`node --import`), resolves `pg` from the application's own root and
 * patches the prototype. CommonJS modules are cached by resolved path, so the instance the application later
 * imports is the one patched here: no loader hooks, no dependency, and it works whether the app is ESM or CJS.
 *
 * Returns the instrumented module's version, or undefined when there is nothing to instrument.
 */
/**
 * Records what a failed operation threw, beside the operation itself.
 *
 * A second operation rather than a field on the first, because they answer different questions and the cloud
 * counts them separately: how often this query runs, and how often *this error* happens. The shape is the one
 * the ADR 0017 left ready — «queries and error signatures share one shape» — so nothing new travels.
 *
 * `product.md:77` asks for the identity of an error and not only its count, and until gh-338 the count was
 * all there was.
 */
function recordErrorIn(
  ctx: RequestContext,
  errors: ErrorFingerprintCache | undefined,
  failed: boolean,
  err: unknown,
  startedAt: number,
  endedAt: number,
): void {
  // Nothing thrown, or nobody asked for signatures: a failure with no error object still counts as a failed
  // query above, which is what it is.
  if (!failed || !errors || err === undefined || err === null) return;
  recordOperationIn(ctx, {
    kind: "error",
    fingerprint: errors.get(err),
    startedAt,
    endedAt,
    failed: true,
  });
}

export function instrumentPg(deps: InstrumentPgDeps): string | undefined {
  let pg: PgModule;
  let version = "unknown";
  try {
    if (deps.moduleImpl !== undefined) {
      pg = deps.moduleImpl as PgModule;
    } else {
      const base = deps.from ?? process.argv[1] ?? `${process.cwd()}/`;
      const require = createRequire(base);
      pg = require("pg") as PgModule;
      const pkg = require("pg/package.json") as { version?: unknown };
      if (typeof pkg.version === "string") version = pkg.version;
    }
  } catch {
    return undefined; // the application does not use pg, or it is not resolvable from here
  }

  const proto = pg.Client?.prototype;
  if (!proto || typeof proto.query !== "function") {
    deps.log.debug("pg found but Client.prototype.query is not a function; not instrumenting");
    return undefined;
  }
  if (proto[MARK] === true) return version;

  const { fingerprints, internalError } = deps;
  const original = proto.query as (...args: unknown[]) => unknown;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    // Only the instrumentation's own work sits inside this `try`, and all of it is best effort: a bug here must never
    // change what the application's query does. In the callback form, putting a callback of its own in place of the
    // application's is the last thing it does, so a failure before it leaves the arguments as the application wrote
    // them. pg is called after the `try`, once, in both forms: what pg throws, or what an application callback it
    // calls throws, is the application's and reaches it as it came, where the `catch` used to take it for the
    // instrumentation's and call pg a second time (gh-662).
    //
    // Every `catch` of this observer, here and in `connect`, hands what it caught to the agent's `internalError` and
    // does nothing else: it is a failure of the instrumentation's own, counted, and at the tenth the instrumentation
    // disables itself (invariant 2, ADR 0161). Nothing here describes it: what is caught can be a value of the
    // application's that `String` throws on, and `internalError` describes it behind a `try` of its own (gh-664).
    let done: ((failed?: boolean, err?: unknown) => void) | undefined;
    try {
      // Inside, because it reads the client's own properties, and what a getter there throws is not the query's.
      const target = targetOfClient(this);
      const started = performance.now();
      const sql = fingerprints ? queryTextOf(args) : undefined;
      let counted = false;
      const record = (failed = false, err?: unknown) => {
        if (counted) return;
        counted = true;
        const ms = performance.now() - started;
        // This runs inside the application's own promise chain, so anything thrown here would surface as the
        // query failing. Measuring is not worth breaking what is being measured (invariants 1 and 2).
        try {
          recordCall("postgres", target, ms, failed);
          // Resolved here, not above, so a query outside a request costs nothing: no context, no fingerprint.
          if (sql !== undefined && fingerprints) {
            const ctx = currentContext();
            if (ctx) {
              recordOperationIn(ctx, {
                kind: "query",
                fingerprint: fingerprints.get(sql),
                startedAt: started,
                endedAt: started + ms,
                failed,
              });
              recordErrorIn(ctx, deps.errors, failed, err, started, started + ms);
            }
          }
        } catch (err) {
          internalError(err);
        }
      };
      const last = args.at(-1);
      if (typeof last === "function") {
        // Callback form: pg invokes this from the connection's own async context, not the caller's, so the
        // request has to be captured here, when the application asks, and written into afterwards. Reading the
        // current context inside the callback would charge the query to whichever request owns that socket.
        const ctx = currentContext();
        const callback = last as (...cbArgs: unknown[]) => unknown;
        args[args.length - 1] = function (this: unknown, ...cbArgs: unknown[]): unknown {
          if (ctx && !counted) {
            counted = true;
            const ms = performance.now() - started;
            // Same reason as above: this runs before the application's callback, and must not replace it.
            try {
              // pg's callback convention: a non-null first argument is the error.
              const failed = cbArgs[0] != null;
              recordCallIn(ctx, "postgres", target, ms, failed);
              if (sql !== undefined && fingerprints) {
                recordOperationIn(ctx, {
                  kind: "query",
                  fingerprint: fingerprints.get(sql),
                  startedAt: started,
                  endedAt: started + ms,
                  failed,
                });
                recordErrorIn(ctx, deps.errors, failed, cbArgs[0], started, started + ms);
              }
            } catch (err) {
              internalError(err);
            }
          }
          return callback.apply(this, cbArgs);
        };
      } else {
        done = record;
      }
    } catch (err) {
      // The instrumentation failed before doing anything: the query goes to pg as the application wrote it, and is
      // not recorded.
      internalError(err);
    }

    const result = original.apply(this, args);
    // The callback form records from its callback, and a query the instrumentation failed to prepare is not recorded.
    if (!done) return result;
    // Promise form. A Cursor or a QueryStream is not thenable and passes through unmeasured, by design.
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      const settle = done;
      return (result as Promise<unknown>).then(
        (value) => {
          settle();
          return value;
        },
        (err: unknown) => {
          settle(true, err);
          throw err; // the application sees exactly the error it would have seen
        },
      );
    }
    done();
    return result;
  };

  proto.query = wrapped;
  proto[MARK] = true;
  wrapPoolConnect(pg, deps);
  deps.log.debug(`instrumented pg ${version}`);
  return version;
}

/**
 * Times how long a request waits for a connection from the pool. That wait is not the database being slow, it is
 * the application having nowhere to run: a pool with nothing free is what turns one slow dependency into a whole
 * service degrading, and it is invisible in the query's own duration.
 */
function wrapPoolConnect(pg: PgModule, deps: InstrumentPgDeps): void {
  const { log, internalError } = deps;
  const proto = pg.Pool?.prototype;
  if (!proto || typeof proto.connect !== "function" || proto[WAIT_MARK] === true) return;

  const original = proto.connect as (...args: unknown[]) => unknown;
  // Recording the wait is best effort, as recording a query is, and a failure goes where a query's does. The pool
  // calls back from the connection's own event and before the application's callback, so a throw there would end
  // the process; in the promise it would hand the application our error instead of its client, and that client
  // would never go back (invariant 2).
  proto.connect = function (this: unknown, ...args: unknown[]): unknown {
    // The same boundary as `query`'s: the instrumentation's own work inside the `try`, and the pool asked after it,
    // once. An ending pool calls the callback before `connect` returns (`pg-pool/index.js:190-194`), so what an
    // application's callback throws comes back through here; inside the `try`, the `catch` asked the pool again and
    // the callback ran twice (gh-662).
    let started: number;
    let promised = false;
    try {
      started = performance.now();
      const last = args.at(-1);
      if (typeof last === "function") {
        // The callback form is how `pool.query()` works inside. The pool queues this callback and calls it later
        // from whoever released a connection, so without binding it the rest of the request would run under
        // another request's context and its queries would be counted against that one.
        const callback = last as (...cbArgs: unknown[]) => unknown;
        const ctx = currentContext();
        // Outside a request there is nothing to attribute, and the callback is left untouched.
        if (ctx) {
          // One binding, not two: an AsyncResource per acquisition is the price of correct attribution, and
          // `pool.query()` acquires a connection for every query, so paying it twice is measurable.
          args[args.length - 1] = AsyncResource.bind(function (this: unknown, ...cbArgs: unknown[]): unknown {
            try {
              recordWaitIn(ctx, "postgres", targetOfClient(cbArgs[1]), performance.now() - started);
            } catch (err) {
              internalError(err);
            }
            return callback.apply(this, cbArgs);
          });
        }
      } else {
        promised = true;
      }
    } catch (err) {
      // The instrumentation failed before doing anything: the pool is asked as the application asked it, and the
      // wait is not recorded.
      internalError(err);
    }
    const result = original.apply(this, args);
    // The callback form records from its callback.
    if (!promised) return result;
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      return (result as Promise<unknown>).then(
        (client) => {
          // The target comes from the client the pool just handed over, so the wait lands on the same dependency
          // as the queries that follow it. A pool built from a connection string knows nothing about its host.
          try {
            recordWait("postgres", targetOfClient(client), performance.now() - started);
          } catch (err) {
            internalError(err);
          }
          return client;
        },
        (err: unknown) => {
          // A pool that timed out waiting is the clearest case of all: count the wait, and let the error through.
          try {
            recordWait("postgres", targetOfPool(this), performance.now() - started);
          } catch (failure) {
            internalError(failure);
          }
          throw err;
        },
      );
    }
    return result;
  };
  proto[WAIT_MARK] = true;
  log.debug("timing waits for a Postgres connection");
}

/**
 * Where a pool points, for the case where it never handed over a client: its options, which are only populated
 * when the pool was built from explicit host and port rather than a connection string. An empty target is better
 * than a wrong one.
 */
function targetOfPool(pool: unknown): string {
  if (!pool || typeof pool !== "object") return "";
  const options = (pool as { options?: { host?: unknown; port?: unknown } }).options;
  const host = options?.host;
  if (typeof host !== "string" || host === "") return "";
  return typeof options?.port === "number" ? `${host}:${options.port}` : host;
}

/** Which database this client talks to, so a read replica and a primary are two dependencies. */
function targetOfClient(client: unknown): string {
  if (!client || typeof client !== "object") return "";
  const { host, port } = client as { host?: unknown; port?: unknown };
  if (typeof host !== "string" || host === "") return "";
  return typeof port === "number" ? `${host}:${port}` : host;
}
