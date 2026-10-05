import { performance } from "node:perf_hooks";
import { currentContext, recordCallIn, recordErrorIn, recordOperationIn, recordWaitIn, runIn } from "../context.ts";
import { applicationEntry } from "../entry.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { FingerprintCache } from "../fingerprint.ts";
import type { Logger } from "../log.ts";
import { type Armed, armDriver } from "./arm.ts";

/**
 * MySQL through `mysql2`, observed as Postgres is through `pg` (DT-91): the queries a request runs, their time and
 * their failures, and how long it waited for a connection from the pool.
 *
 * It is `pg.ts`'s pattern (ADR 0009) with the three differences `mysql2` makes:
 *
 * - **The callback is the driver's shape**, and not a promise. `mysql2`'s core API is callbacks, its promise
 *   wrapper is built on them, and every query the ORMs run reaches `Connection.prototype.query` or `.execute`
 *   with a callback — or, from the pool, as a command that carries it in `onResult`. What `query` returns is a
 *   command that throws if anybody asks it for a `then`, so this never does.
 * - **The application's callback runs in the context of the call that gave it.** The driver finishes a query on
 *   the connection's socket, in the async context the socket was born in: the request that happened to open the
 *   connection, and finished long ago. A second query asked from inside the callback — the callback API's whole
 *   shape — would be asked from that context, and belong to a request that did not ask for it (gh-89). So the
 *   context is taken when the application calls, the result is recorded into it, and the callback runs in it —
 *   `runIn`, which changes the store this agent owns and none of the application's own.
 * - **The text is read before the driver formats it.** `mysql2` puts the values into the SQL on the client, before
 *   it sends it, so the template the application wrote is the only text here that carries none, and it is also the
 *   one that repeats: one text per query, and not one per set of values.
 *
 * The text is normalised as MySQL's (`fingerprint.ts`, ADR 0086): a double quote there delimits a value.
 */

const MARK = Symbol.for("downtrace.mysql.instrumented");
const POOL_MARK = Symbol.for("downtrace.mysql.pool.instrumented");

/** Shape of the part of `mysql2` we touch. Anything else about the module is none of our business. */
interface Proto extends Record<string, unknown> {
  [MARK]?: boolean;
  [POOL_MARK]?: boolean;
}

interface Mysql2Module {
  Connection?: { prototype?: Proto };
  Pool?: { prototype?: Proto };
}

/**
 * The prototype that defines `name`, at or above `start`: the one a patch has to land on to reach every class that
 * inherits it.
 *
 * Not the exported `Connection`'s own. Up to mysql2 3.18 a pooled connection is not a `Connection`: `PoolConnection`
 * extends a `BasePoolConnection` that extends the same base class `Connection` does, so a wrapper on
 * `Connection.prototype` reaches `createConnection` and not a pool — which is the way TypeORM and every
 * callback-API application hold the driver — and from 3.20 it is one. `query` and `execute` are defined on the base
 * in both layouts, and that is where this finds them; the pool's `getConnection` the same, a layer above `Pool`.
 */
function ownerOf(start: Proto | undefined, name: string): Proto | undefined {
  for (let proto = start; proto !== undefined && proto !== null && proto !== Object.prototype; ) {
    if (Object.hasOwn(proto, name)) return typeof proto[name] === "function" ? proto : undefined;
    proto = Object.getPrototypeOf(proto) as Proto | undefined;
  }
  return undefined;
}

export interface InstrumentMysqlDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at
   * debug, sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /**
   * Where the query text becomes a fingerprint, **read as MySQL**: a cache made for another dialect would keep
   * the content of a double-quoted value (ADR 0086). Absent means no profile is being built, and then the text
   * is never even looked at.
   */
  fingerprints?: FingerprintCache | undefined;
  /** Where a thrown thing becomes a signature. Absent means errors are counted and not identified. */
  errors?: ErrorFingerprintCache | undefined;
}

/**
 * The text of the query, as the application wrote it: `mysql2` takes it as a string, as an options object, or as
 * the command a pool builds, which has the same `sql`. Anything else is not a text we can read.
 */
function queryTextOf(first: unknown): string | undefined {
  if (typeof first === "string") return first;
  if (first !== null && typeof first === "object") {
    const sql = (first as { sql?: unknown }).sql;
    if (typeof sql === "string") return sql;
  }
  return undefined;
}

/**
 * Patches the `mysql2` module the application loaded: the wrapper on `query` and `execute` of the class that
 * defines them — which every connection, pooled or not, inherits — and the wait on the pool's `getConnection`, with
 * the marks that keep it to one. Returns whether there was anything to patch.
 *
 * The module is handed over already loaded: the production start-up does not load it (ADR 0209, `armMysql`), and a
 * test gives one.
 */
export function patchMysql(module: unknown, version: string, deps: InstrumentMysqlDeps): boolean {
  const mysql = module as Mysql2Module | null | undefined;
  const connection = mysql?.Connection?.prototype;
  const proto = ownerOf(connection, "query");
  if (!proto) {
    deps.log.debug("mysql2 found but Connection.prototype.query is not a function; not instrumenting");
    return false;
  }
  if (proto[MARK] === true) return true;
  wrapStatement(proto, "query", deps);
  // `execute` is the prepared statement, which Sequelize uses for anything with bind parameters. A driver that
  // has none is a driver this observer still serves.
  const executes = ownerOf(connection, "execute");
  if (executes) wrapStatement(executes, "execute", deps);
  proto[MARK] = true;
  wrapPoolConnection(ownerOf(mysql?.Pool?.prototype, "getConnection"), deps);
  deps.log.debug(`instrumented mysql2 ${version}`);
  return true;
}

/**
 * The start-up half, as `pg`'s: resolve `mysql2` from the application's root, load nothing, and patch from the
 * start of the first request at which the application has loaded it (ADR 0209).
 */
export function armMysql(deps: InstrumentMysqlDeps & { from?: string | undefined }): Armed {
  return armDriver<unknown>({
    driver: "mysql2",
    from: deps.from ?? applicationEntry(),
    log: deps.log,
    internalError: deps.internalError,
    patch: (module, version) => {
      patchMysql(module, version, deps);
    },
  });
}

/**
 * Wraps `query` or `execute` so the statement counts towards the request that asked for it.
 *
 * Only the instrumentation's own work sits inside the `try`, and all of it is best effort: a bug here must never
 * change what the application's query does. Putting a callback of its own in place of the application's is the
 * last thing it does, so a failure before it leaves the arguments as the application wrote them. The driver is
 * called after the `try`, once: what it throws, or what an application callback it calls throws, is the
 * application's and reaches it as it came (gh-662).
 */
function wrapStatement(proto: Proto, method: "query" | "execute", deps: InstrumentMysqlDeps): void {
  const original = proto[method] as (...args: unknown[]) => unknown;
  proto[method] = function (this: unknown, ...args: unknown[]): unknown {
    let afterwards: (() => void) | undefined;
    try {
      afterwards = observe(this, args, deps);
    } catch (err) {
      // The instrumentation failed before doing anything: the statement goes to the driver as the application
      // wrote it, and is not recorded.
      deps.internalError(err);
    }
    const result = original.apply(this, args);
    if (afterwards !== undefined) {
      try {
        afterwards();
      } catch (err) {
        deps.internalError(err);
      }
    }
    return result;
  };
}

/**
 * Takes the context, starts the clock and arranges for the statement to be recorded when it ends. Returns what to
 * do after the driver has returned, for the one form that ends in no callback.
 */
function observe(connection: unknown, args: unknown[], deps: InstrumentMysqlDeps): (() => void) | undefined {
  // The request that is asking, taken now and not when the statement ends: the driver finishes on the
  // connection's socket, which belongs to whichever request opened it (gh-89). Outside a request there is
  // nothing to attribute and the call goes through untouched, with no clock, no text and no binding.
  const ctx = currentContext();
  if (!ctx) return undefined;
  const { fingerprints, errors, internalError } = deps;
  // Inside, because it reads the connection's own properties, and what a getter there throws is not the query's.
  const target = targetOfConnection(connection);
  const started = performance.now();
  const sql = fingerprints ? queryTextOf(args[0]) : undefined;
  let counted = false;
  const settle = (err: unknown): void => {
    if (counted) return;
    counted = true;
    const ms = performance.now() - started;
    // This runs inside the driver's own callback chain, so anything thrown here would surface as the query
    // failing. Measuring is not worth breaking what is being measured (invariants 1 and 2).
    try {
      // `mysql2`'s convention, as `pg`'s callback form: a non-null first argument is the error.
      const failed = err !== null && err !== undefined;
      recordCallIn(ctx, "mysql", target, ms, failed);
      if (sql !== undefined && fingerprints) {
        recordOperationIn(ctx, {
          kind: "query",
          fingerprint: fingerprints.get(sql),
          startedAt: started,
          endedAt: started + ms,
          failed,
          target,
        });
        recordErrorIn(ctx, errors, failed, err, target, started, started + ms);
      }
    } catch (failure) {
      internalError(failure);
    }
  };

  // The callback form, which is how every ORM reaches the driver: the last argument is the application's callback.
  // Replaced by one that records and then calls it, in the context of the call that gave it.
  const last = args.at(-1);
  if (typeof last === "function") {
    const callback = last as (...cbArgs: unknown[]) => unknown;
    args[args.length - 1] = function (this: unknown, ...cbArgs: unknown[]): unknown {
      settle(cbArgs[0]);
      return runIn(ctx, () => callback.apply(this, cbArgs));
    };
    return undefined;
  }

  // The command a pool built, handed to the connection with the callback inside it. The driver reads `onResult`
  // when the statement ends, so replacing it now — before the driver is called — takes in every way it can end.
  const command = args[0];
  if (
    command !== null &&
    typeof command === "object" &&
    typeof (command as { onResult?: unknown }).onResult === "function"
  ) {
    const holder = command as { onResult: (...cbArgs: unknown[]) => unknown };
    const onResult = holder.onResult;
    holder.onResult = function (this: unknown, ...cbArgs: unknown[]): unknown {
      settle(cbArgs[0]);
      return runIn(ctx, () => onResult.apply(this, cbArgs));
    };
    return undefined;
  }

  // The event form — listeners on the command, or a stream — settles on events whose listeners are the
  // application's, and one of ours on `error` would swallow an error nobody handles. It is counted when it is
  // issued, with the time that takes and no failure: a profile needs the count, and a `pg` cursor is treated the
  // same way.
  return () => settle(undefined);
}

/**
 * Times how long a request waits for a connection from the pool. That wait is not the database being slow, it is
 * the application having nowhere to run: a pool with nothing free is what turns one slow dependency into a whole
 * service degrading, and it is invisible in the query's own duration.
 */
function wrapPoolConnection(proto: Proto | undefined, deps: InstrumentMysqlDeps): void {
  const { log, internalError } = deps;
  if (!proto) {
    log.debug(
      "mysql2 found but Pool.prototype.getConnection is not a function; the wait for a connection is not timed",
    );
    return;
  }
  if (proto[POOL_MARK] === true) return;
  const original = proto.getConnection as (...args: unknown[]) => unknown;
  // `pool.query()` asks for a connection through here, and so does the promise wrapper's `getConnection()`.
  proto.getConnection = function (this: unknown, ...args: unknown[]): unknown {
    try {
      const last = args.at(-1);
      const ctx = typeof last === "function" ? currentContext() : undefined;
      // Outside a request there is nothing to attribute, and the callback is left untouched.
      if (ctx) {
        const callback = last as (...cbArgs: unknown[]) => unknown;
        const started = performance.now();
        const pool = this;
        // The pool queues this callback when nothing is free and calls it later, from whoever released a
        // connection. Run in the context of the call that asked, so that the rest of the request — the query
        // `pool.query()` goes on to run from here — is asked by this request and not by that one (gh-89).
        args[args.length - 1] = function (this: unknown, ...cbArgs: unknown[]): unknown {
          try {
            // The pool's own target when it gave up, the connection's when it handed one over: the same
            // string either way, so the wait and the queries that follow it are one dependency.
            const target = cbArgs[0] ? targetOfPool(pool) : targetOfConnection(cbArgs[1]) || targetOfPool(pool);
            recordWaitIn(ctx, "mysql", target, performance.now() - started);
          } catch (err) {
            internalError(err);
          }
          return runIn(ctx, () => callback.apply(this, cbArgs));
        };
      }
    } catch (err) {
      // The instrumentation failed before doing anything: the pool is asked as the application asked it, and
      // the wait is not recorded.
      internalError(err);
    }
    return original.apply(this, args);
  };
  proto[POOL_MARK] = true;
  log.debug("timing waits for a MySQL connection");
}

/**
 * Where a connection points: the socket it was asked to open, or the host and the port. Never the user, the
 * password or the database, which are in the same configuration and are not a name for a dependency. The
 * driver fills in the host (`localhost`) and the port (3306) it was not given, so the string is the same
 * whether the application wrote them or not.
 */
function targetOfConfig(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const { host, port, socketPath } = config as { host?: unknown; port?: unknown; socketPath?: unknown };
  if (typeof socketPath === "string" && socketPath !== "") return socketPath;
  if (typeof host !== "string" || host === "") return "";
  return typeof port === "number" ? `${host}:${port}` : host;
}

function targetOfConnection(connection: unknown): string {
  if (!connection || typeof connection !== "object") return "";
  return targetOfConfig((connection as { config?: unknown }).config);
}

/** Where a pool points when a wait on it ends without a connection: the configuration its connections are made from. */
function targetOfPool(pool: unknown): string {
  if (!pool || typeof pool !== "object") return "";
  const config = (pool as { config?: { connectionConfig?: unknown } }).config;
  return targetOfConfig(config?.connectionConfig);
}
