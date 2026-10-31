import { performance } from "node:perf_hooks";
import { currentContext, recordCallIn, recordErrorIn, recordOperationIn, runIn } from "../context.ts";
import { applicationEntry, type From } from "../entry.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { FingerprintCache } from "../fingerprint.ts";
import type { Logger } from "../log.ts";
import { type Armed, armDriver, whenRequired } from "./arm.ts";

/**
 * SQL Server through `tedious`, the driver of `mssql` — and so of TypeORM, Knex and Prisma's adapter for SQL Server —
 * and of Sequelize's `mssql` dialect, which calls it itself (ADR 0245). Observed as `mysql2` is (`mysql.ts`): the
 * statements a request runs, their time and their failures, as the dependency `mssql`.
 *
 * Every request `tedious` sends — `execSql`, `execSqlBatch`, `callProcedure`, `prepare` and `execute`, a bulk load,
 * and the begin, commit and rollback of a transaction — goes through one method, `Connection.prototype.makeRequest`,
 * with the request whose `callback` the driver calls when it ends. That is the wrapper: the request that asked is
 * taken there, and the callback is replaced by one that records the statement and runs the application's in that
 * request, because the driver ends it on the connection's socket, whose context is whichever request opened it
 * (gh-89). A statement's text is `sqlTextOrProcedure`, as the application wrote it, read as T-SQL; a transaction's
 * round trips and a bulk load have none, and are calls with no operation.
 *
 * What it does not say: what the connection sends as it logs in (its session's options), which does not go through
 * `makeRequest`; the `SELECT 1;` with which `mssql`'s pool validates every connection it hands over, which is the
 * pool's and no route's (`patchMssql`); and the wait for a connection, which `mssql` keeps in a pool of its own (tarn)
 * that has no request to wrap.
 */

const MARK = Symbol.for("downtrace.mssql.instrumented");
/** The application's own callback, kept on the request so that running it again wraps that one and not a wrapper. */
const OWN_CALLBACK = Symbol.for("downtrace.mssql.callback");

/**
 * What each handle a connection prepared runs. `mssql`'s prepared statement sends its text once, to `sp_prepare`, and
 * then only the handle the server gave it back, to `sp_execute`: without this every prepared statement of an
 * application would be one operation, `sp_execute`. A handle belongs to the connection that prepared it.
 */
const PREPARED = new WeakMap<object, Map<unknown, string>>();

function preparedOn(connection: object): Map<unknown, string> {
  let statements = PREPARED.get(connection);
  if (statements === undefined) {
    statements = new Map();
    PREPARED.set(connection, statements);
  }
  return statements;
}

/** The value of a parameter of a request, by its name, as `tedious` keeps them. */
function parameterOf(request: RequestLike, name: string): unknown {
  const parameters = request.parameters;
  if (!Array.isArray(parameters)) return undefined;
  return (parameters as Array<{ name?: unknown; value?: unknown }>).find((p) => p?.name === name)?.value;
}

/**
 * What a request runs, as the application wrote it: its text, the statement a prepared handle stands for, or the name
 * of the procedure it calls. Remembers what `sp_prepare` is given, whether or not a request is asking: an application
 * prepares at start-up, and executes in its requests.
 */
function textOf(connection: unknown, request: RequestLike): string | undefined {
  const text = request.sqlTextOrProcedure;
  if (typeof text !== "string" || text === "") return undefined;
  if (connection === null || typeof connection !== "object") return text;
  if (text === "sp_prepare") {
    const statement = parameterOf(request, "stmt");
    const on = (request as { on?: unknown }).on;
    if (typeof statement === "string" && typeof on === "function") {
      on.call(request, "returnValue", (name: unknown, value: unknown) => {
        if (name === "handle") preparedOn(connection).set(value, statement);
      });
    }
  } else if (text === "sp_execute") {
    return preparedOn(connection).get(parameterOf(request, "handle")) ?? text;
  } else if (text === "sp_unprepare") {
    preparedOn(connection).delete(parameterOf(request, "handle"));
  }
  return text;
}

const POOL_MARK = Symbol.for("downtrace.mssql.pool.instrumented");

interface Proto extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
  [POOL_MARK]?: boolean;
}

/**
 * How deep the code that is running is inside `mssql`'s validation of a connection. It sends its `SELECT 1;` from
 * there synchronously, so a count that is up while the validation runs is enough to tell its request from a route's.
 */
let validating = 0;

interface RequestLike extends Record<string | symbol, unknown> {
  callback?: unknown;
  sqlTextOrProcedure?: unknown;
  parameters?: unknown;
  [OWN_CALLBACK]?: (...args: unknown[]) => unknown;
}

export interface InstrumentMssqlDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at debug,
   * sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /** Where the text becomes a fingerprint, read as T-SQL. Absent means the text is never looked at. */
  fingerprints?: FingerprintCache | undefined;
  /** Where a thrown thing becomes a signature. Absent means errors are counted and not identified. */
  errors?: ErrorFingerprintCache | undefined;
}

/** Patches `makeRequest` of the `tedious` the application loaded. Returns whether there was anything to patch. */
export function patchTedious(module: unknown, version: string, deps: InstrumentMssqlDeps): boolean {
  const proto = (module as { Connection?: { prototype?: Proto } } | null | undefined)?.Connection?.prototype;
  if (proto?.[MARK] === true) return true;
  if (!proto || typeof proto.makeRequest !== "function") {
    deps.log.debug("tedious found but Connection.prototype.makeRequest is not a function; not instrumenting");
    return false;
  }
  const original = proto.makeRequest as (...args: unknown[]) => unknown;
  proto.makeRequest = function (this: unknown, ...args: unknown[]): unknown {
    try {
      observe(this, args[0], deps);
    } catch (err) {
      // The instrumentation failed before replacing anything: the request goes as the application made it.
      deps.internalError(err);
    }
    return original.apply(this, args);
  };
  proto[MARK] = true;
  deps.log.debug(`instrumented tedious ${version}`);
  return true;
}

/**
 * Patches the validation of `mssql`'s pool, so that the `SELECT 1;` it sends before it hands a connection over is not
 * counted: it is sent in the request that asked for a connection, and no route wrote it. Returns whether there was a
 * validation to patch.
 */
export function patchMssql(module: unknown, deps: InstrumentMssqlDeps): boolean {
  let proto = (module as { ConnectionPool?: { prototype?: Proto } } | null | undefined)?.ConnectionPool?.prototype;
  while (proto && proto !== Object.prototype && !Object.hasOwn(proto, "_poolValidate")) {
    proto = Object.getPrototypeOf(proto) as Proto | undefined;
  }
  if (!proto || proto === Object.prototype || typeof proto._poolValidate !== "function") {
    deps.log.debug("mssql found but its pool has no _poolValidate; a validation it sends is counted");
    return false;
  }
  if (proto[POOL_MARK] === true) return true;
  const original = proto._poolValidate as (...args: unknown[]) => unknown;
  proto._poolValidate = function (this: unknown, ...args: unknown[]): unknown {
    validating += 1;
    try {
      return original.apply(this, args);
    } finally {
      validating -= 1;
    }
  };
  proto[POOL_MARK] = true;
  return true;
}

/**
 * The start-up half (ADR 0209): resolve `tedious` from the application's root, and from `mssql`, which brings its own,
 * load nothing, and patch from the first request at which the application has loaded it.
 */
export function armTedious(deps: InstrumentMssqlDeps & { from?: From | undefined }): Armed {
  return armDriver<unknown>({
    driver: "tedious",
    from: deps.from ?? applicationEntry(),
    beside: ["mssql"],
    log: deps.log,
    internalError: deps.internalError,
    patch: (module, version) => {
      patchTedious(module, version, deps);
    },
  });
}

/**
 * `mssql`'s validation, patched as the application loads the package and not at the first request: its pool binds
 * `_poolValidate` as it is built, which an application does at start-up, and a pool built before the patch keeps the
 * method it bound. On Node 20, which has no `module.require` channel, only a copy loaded before the instrumentation
 * started is patched in time. Returns what stops listening.
 */
export function watchMssql(deps: InstrumentMssqlDeps & { from?: From | undefined }): () => void {
  return whenRequired({
    name: "mssql",
    from: deps.from ?? applicationEntry(),
    patch: (exports) => {
      patchMssql(exports, deps);
    },
    internalError: deps.internalError,
  });
}

function observe(connection: unknown, request: unknown, deps: InstrumentMssqlDeps): void {
  if (validating > 0) return;
  if (request === null || typeof request !== "object") return;
  const asked = request as RequestLike;
  const text = textOf(connection, asked);
  const ctx = currentContext();
  if (!ctx) return;
  const own = asked[OWN_CALLBACK] ?? asked.callback;
  if (typeof own !== "function") return;
  const { fingerprints, errors, internalError } = deps;
  const target = targetOf((connection as { config?: unknown } | null)?.config);
  const sql = fingerprints ? text : undefined;
  const started = performance.now();
  let counted = false;
  const settle = (err: unknown): void => {
    if (counted) return;
    counted = true;
    // This runs inside the driver's handling of the server's answer: anything thrown here would be the driver's.
    try {
      const ended = performance.now();
      const failed = err !== null && err !== undefined;
      recordCallIn(ctx, "mssql", target, ended - started, failed);
      if (sql !== undefined && fingerprints) {
        recordOperationIn(ctx, {
          kind: "query",
          fingerprint: fingerprints.get(sql),
          startedAt: started,
          endedAt: ended,
          failed,
          target,
        });
        recordErrorIn(ctx, errors, failed, err, target, started, ended);
      }
    } catch (failure) {
      internalError(failure);
    }
  };
  asked[OWN_CALLBACK] = own as (...args: unknown[]) => unknown;
  asked.callback = function (this: unknown, ...result: unknown[]): unknown {
    settle(result[0]);
    return runIn(ctx, () => (own as (...a: unknown[]) => unknown).apply(this, result));
  };
}

/**
 * Where a connection points: the server and its port, or the server and its instance, which is what the driver was
 * told to reach. Never the user, the password or the database.
 */
function targetOf(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const { server, options } = config as { server?: unknown; options?: { port?: unknown; instanceName?: unknown } };
  if (typeof server !== "string" || server === "") return "";
  if (typeof options?.port === "number") return `${server}:${options.port}`;
  if (typeof options?.instanceName === "string" && options.instanceName !== "") {
    return `${server}\\${options.instanceName}`;
  }
  return server;
}
