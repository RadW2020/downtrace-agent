import { AsyncResource } from "node:async_hooks";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { PgDepth } from "../config.ts";
import {
  currentContext,
  recordCall,
  recordCallIn,
  recordErrorIn,
  recordOperationIn,
  recordWait,
  recordWaitIn,
} from "../context.ts";
import { applicationEntry } from "../entry.ts";
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
  /**
   * Resolution base: the start passes the application's entry as Node runs it, resolved once with the
   * process's own flags. Absent, it is `applicationEntry()`, the entry as Node runs it by default (DT-34).
   */
  from?: string | undefined;
  /** Injected in tests instead of resolving the real module. */
  moduleImpl?: unknown;
  /**
   * How much of the attribution this observer performs; `full` (the default) is the observer as it is.
   * `context` records the calls and the waits against the request and never looks at the query text, and
   * `wrapper` only leaves the patch in place: the wrapper runs and records nothing. The benchmark's switch
   * for weighing the observer part by part (gh-592); it changes what the observer does, never what the
   * application's query does, and an operator leaves it alone.
   */
  depth?: PgDepth | undefined;
}

/**
 * What `armPg` leaves behind at start-up: what the batch can already report, and the attach that runs the
 * patch from the start of a request.
 */
export interface PgArmed {
  /** Resolved from the application's root: «on», or «unavailable» when there is no `pg` to instrument. */
  state: "on" | "unavailable";
  /**
   * Patches the driver once the application has loaded it. Called from the start of each request until it
   * settles: `true` when the attach is done — patched, or decided there is nothing to patch — and `false`
   * while the application has not loaded the driver yet.
   */
  attach: () => boolean;
}

/**
 * Wraps `pg`'s `Client.prototype.query` so every query counts towards the request that issued it.
 *
 * The module is handed over already loaded — a test gives one, or the caller resolves and requires it from
 * the application's root — and the patch lands on the prototype the application actually uses: no loader
 * hooks, no dependency, and it works whether the app is ESM or CJS. The production start-up does not call
 * this one; it calls `armPg`, which defers the load to the application (ADR 0209).
 *
 * Returns the instrumented module's version, or undefined when there is nothing to instrument.
 */
export function instrumentPg(deps: InstrumentPgDeps): string | undefined {
  let pg: PgModule;
  let version = "unknown";
  try {
    if (deps.moduleImpl !== undefined) {
      pg = deps.moduleImpl as PgModule;
    } else {
      const require = createRequire(deps.from ?? applicationEntry());
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
  patchClientAndPool(pg, version, deps);
  return version;
}

/**
 * The start-up half of `pg`'s instrumentation: it resolves the driver from the application's root and does
 * not load it (ADR 0209).
 *
 * Loading it here would warm the module cache before the application's own load, and a tracker that
 * instruments `pg` by hooking module loading would then never see the driver the way it would alone: with
 * this observer loaded first, its hook for `pg-pool` would never run at all (the application loads `pg` once,
 * from the cache this observer warmed); with the tracker loaded first, its hook would run a second time on
 * top of this observer's wrapper, which it does not recognise as one, and would wrap the query twice.
 * Resolving keeps the patch where it has to be — on the prototype the application actually uses, whatever
 * order the two are loaded in — without taking the load from the application.
 *
 * The patch itself runs in `attach`, from the start of the first request at which the driver is in the
 * module cache: by then the application has loaded it (a server that answers a request has finished its
 * start-up), the `require` is a cache hit that re-executes nothing, and the wrapper is in place before the
 * request's handler runs. What that moment gives up is said in ADR 0209: a query the application makes in
 * the very request that loads the driver for the first time — a lazy import in a handler — is the one this
 * observer does not count; from the next request it counts again.
 */
export function armPg(deps: Omit<InstrumentPgDeps, "moduleImpl">): PgArmed {
  const require = createRequire(deps.from ?? applicationEntry());
  let resolved: string;
  try {
    resolved = require.resolve("pg");
  } catch {
    deps.log.debug("pg is not resolvable from the application's root; not instrumenting");
    return { state: "unavailable", attach: () => true };
  }
  // The version of the log, read at start-up where the old start-up require read it, and not in a request.
  let version = "unknown";
  try {
    const pkg = require("pg/package.json") as { version?: unknown };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    deps.log.debug("pg resolved but its version could not be read; it stays unknown");
  }
  let settled = false;
  const attach = (): boolean => {
    if (settled) return true;
    try {
      // Until the application loads the driver there is nothing to patch, and nothing is lost by waiting:
      // a query cannot run before the driver is loaded, and a query outside a request is not counted
      // (`context.ts`). The check is one property read on the module cache, once per request until then.
      if (require.cache[resolved] === undefined) return false;
      settled = true;
      const pg = require("pg") as PgModule;
      const proto = pg.Client?.prototype;
      if (!proto || typeof proto.query !== "function") {
        deps.log.debug("pg found but Client.prototype.query is not a function; not instrumenting");
        return true;
      }
      if (proto[MARK] === true) return true;
      patchClientAndPool(pg, version, deps);
      return true;
    } catch (err) {
      // A failure of the attach is a failure of the instrumentation's own: counted like any other
      // (invariant 2, ADR 0161), and never handed to the request that asked for it.
      settled = true;
      deps.internalError(err);
      return true;
    }
  };
  return { state: "on", attach };
}

/**
 * The patch both entry points share: the wrapper on `Client.prototype.query`, the wait on
 * `Pool.prototype.connect`, and the marks that keep it to one. The shape of the module was checked by the
 * caller, which is the one that knows how to say it is wrong.
 */
function patchClientAndPool(pg: PgModule, version: string, deps: InstrumentPgDeps): void {
  const proto = pg.Client?.prototype;
  if (!proto || typeof proto.query !== "function") {
    deps.log.debug("pg found but Client.prototype.query is not a function; not instrumenting");
    return;
  }
  if (proto[MARK] === true) return;

  const { fingerprints, internalError } = deps;
  if (deps.depth === "wrapper") {
    // The floor of the observer: the patch is in place and the wrapper runs, and records nothing — no timing,
    // no attribution, no pool wrap, because those exist to charge the work to a request. The benchmark
    // weighs this against nothing to say what wrapping costs on its own (gh-592). A pass-through cannot fail
    // in code of its own: it calls the original once and returns what it returns.
    const original = proto.query as (...args: unknown[]) => unknown;
    proto.query = function (this: unknown, ...args: unknown[]): unknown {
      return original.apply(this, args);
    };
    proto[MARK] = true;
    deps.log.debug(`instrumented pg ${version} (wrapper only: it records nothing)`);
    return;
  }
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
              // With its target, so a database the operator excluded leaves no query either (ADR 0101).
              recordOperationIn(ctx, {
                kind: "query",
                fingerprint: fingerprints.get(sql),
                startedAt: started,
                endedAt: started + ms,
                failed,
                target,
              });
              recordErrorIn(ctx, deps.errors, failed, err, target, started, started + ms);
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
                  target,
                });
                recordErrorIn(ctx, deps.errors, failed, cbArgs[0], target, started, started + ms);
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
          const pool = this;
          args[args.length - 1] = AsyncResource.bind(function (this: unknown, ...cbArgs: unknown[]): unknown {
            try {
              const target = cbArgs[0] ? targetOfWaitingPool(pool) : handedOver(pool, cbArgs[1]);
              recordWaitIn(ctx, "postgres", target, performance.now() - started);
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
            recordWait("postgres", handedOver(this, client), performance.now() - started);
          } catch (err) {
            internalError(err);
          }
          return client;
        },
        (err: unknown) => {
          // A pool that timed out waiting is the clearest case of all: count the wait, and let the error through.
          try {
            recordWait("postgres", targetOfWaitingPool(this), performance.now() - started);
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

/** The target of the last client each pool handed over: what a wait that ends without a client belongs to. */
const poolTargets = new WeakMap<object, string>();

/** The port a `pg` client reports when its connection string names none. */
const DEFAULT_PG_PORT = 5432;

/**
 * The target of a client the pool just handed over, which is also where the pool points: remembered, so that a wait
 * on the same pool that ends in a timeout lands on the same dependency as the waits and the queries that came before
 * it (DT-36). The client's own target, and not the pool's, so the wait and the queries that follow it agree.
 */
function handedOver(pool: unknown, client: unknown): string {
  const target = targetOfClient(client);
  if (target !== "" && pool && typeof pool === "object") poolTargets.set(pool, target);
  return target;
}

/**
 * Where a pool points when a wait on it ends without a client — the case a pool run dry is made of. In order: the
 * target of the clients it has handed over; its options, populated when it was built from host and port; its
 * connection string, which is how most pools are built (`DATABASE_URL`). An empty target is better than a wrong one,
 * but a nameless one has no reference to be judged against, and a saturated pool went unjudged that way.
 */
function targetOfWaitingPool(pool: unknown): string {
  if (!pool || typeof pool !== "object") return "";
  const remembered = poolTargets.get(pool);
  if (remembered !== undefined) return remembered;
  const options = (pool as { options?: { host?: unknown; port?: unknown; connectionString?: unknown } }).options;
  const host = options?.host;
  if (typeof host === "string" && host !== "") {
    return typeof options?.port === "number" ? `${host}:${options.port}` : host;
  }
  return targetOfConnectionString(options?.connectionString);
}

/**
 * The host and port of a `postgres://` or `postgresql://` connection string, as a client built from it would report
 * them: the default port when the string names none. Never its user, password or database. Empty when the string
 * names no host this can read — a socket path in the query, or not a URL at all.
 */
function targetOfConnectionString(dsn: unknown): string {
  if (typeof dsn !== "string" || dsn === "") return "";
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return "";
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return "";
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "") return "";
  return `${host}:${url.port === "" ? DEFAULT_PG_PORT : url.port}`;
}

/** Which database this client talks to, so a read replica and a primary are two dependencies. */
function targetOfClient(client: unknown): string {
  if (!client || typeof client !== "object") return "";
  const { host, port } = client as { host?: unknown; port?: unknown };
  if (typeof host !== "string" || host === "") return "";
  return typeof port === "number" ? `${host}:${port}` : host;
}
