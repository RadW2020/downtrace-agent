import { performance } from "node:perf_hooks";
import { currentContext, type RequestContext, recordCallIn, recordErrorIn, recordOperationIn } from "../context.ts";
import type { InstrumentSqliteDeps } from "./sqlite.ts";

/**
 * SQLite through node-sqlite3 (`sqlite3`), the callback driver Knex and Sequelize open SQLite with: the statements a
 * request runs, under the dependency `sqlite` of ADR 0239, read as SQLite, with no target.
 *
 * Every statement runs through the class every statement of the driver shares, `Statement`, whose `run`, `get`, `all`
 * and `each` are the addon's: `Database`'s methods of the same names make a `Statement` and call them, and a
 * statement prepared at start-up calls them at each run. Each keeps its text as `sql`. `exec` is the database's own.
 * `Database`'s are wrapped too, for a statement that does not compile, which the driver answers through the
 * database's callback without running it. Statements run on a thread of the addon's and answer through the callback
 * they are given, last: the context and the clock are taken at the call, in the request that made it, and the
 * statement is finished when its callback is called — with what the driver gives it, `this` included, untouched. A
 * callback driver is wrapped here and not in MongoDB's case (ADR 0237) because nothing comes between the call and the
 * request: no pool hands it a connection.
 *
 * A statement run with no callback is not counted: nothing says when it ends, and giving it one would change where its
 * errors go (the driver emits them when there is no callback). `each`'s completion is its second callback; with one
 * only, that one is per row, and the statement is not counted either.
 */

const MARK = Symbol.for("downtrace.sqlite3.instrumented");

/** The methods of a statement that run it. */
const RUNS = ["run", "get", "all", "each"] as const;

type Callback = (this: unknown, ...args: unknown[]) => unknown;

/**
 * The callbacks a wrapper here has already put in place. `Database`'s methods hand theirs to the `Statement` they make,
 * and to the statement's preparation, whose failure the driver answers through it before anything runs: wrapped at the
 * database, a callback is not wrapped again at the statement.
 */
const wrapped = new WeakSet<Callback>();

interface Proto extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
}

/** The index of the callback that says a run ended, or -1 when there is none. */
function completionOf(method: string, args: readonly unknown[]): number {
  const callbacks = args.flatMap((arg, i) => (typeof arg === "function" ? [i] : []));
  if (method === "each") return callbacks.length >= 2 ? (callbacks.at(-1) as number) : -1;
  return args.length > 0 && typeof args[args.length - 1] === "function" ? args.length - 1 : -1;
}

function record(
  ctx: RequestContext,
  sql: string | undefined,
  started: number,
  err: unknown,
  deps: InstrumentSqliteDeps,
): void {
  // Inside the driver's callback, before the application's: what is thrown here would be the application's to see.
  // Measuring is not worth breaking what is measured (invariant 2).
  try {
    const ended = performance.now();
    const failed = err !== undefined && err !== null;
    recordCallIn(ctx, "sqlite", "", ended - started, failed);
    if (sql !== undefined && deps.fingerprints) {
      recordOperationIn(ctx, {
        kind: "query",
        fingerprint: deps.fingerprints.get(sql),
        startedAt: started,
        endedAt: ended,
        failed,
        target: "",
      });
      recordErrorIn(ctx, deps.errors, failed, err, "", started, ended);
    }
  } catch (failure) {
    deps.internalError(failure);
  }
}

/** Wraps a method that runs SQL and answers through its last callback: the statement's, or the database's `exec`. */
function wrap(
  proto: Proto,
  method: string,
  sqlOf: (self: unknown, args: readonly unknown[]) => unknown,
  deps: InstrumentSqliteDeps,
): void {
  const original = proto[method];
  if (typeof original !== "function") return;
  proto[method] = function (this: unknown, ...args: unknown[]): unknown {
    const ctx = currentContext();
    if (!ctx) return original.apply(this, args);
    let completion: number;
    let sql: string | undefined;
    try {
      completion = completionOf(method, args);
      const text = sqlOf(this, args);
      sql = typeof text === "string" ? text : undefined;
    } catch (err) {
      deps.internalError(err);
      return original.apply(this, args);
    }
    if (completion < 0 || wrapped.has(args[completion] as Callback)) return original.apply(this, args);
    const callback = args[completion] as Callback;
    const started = performance.now();
    const finished: Callback = function (this: unknown, ...answer: unknown[]): unknown {
      record(ctx, sql, started, answer[0], deps);
      return callback.apply(this, answer);
    };
    wrapped.add(finished);
    args[completion] = finished;
    return original.apply(this, args);
  };
}

/**
 * Patches node-sqlite3's `Statement` and `Database`, given the module the application loaded. Returns whether there
 * was anything to patch. The production start-up does not load it (ADR 0209, `armSqlite`), and a test gives one.
 */
export function patchSqlite3(module: unknown, version: string, deps: InstrumentSqliteDeps): boolean {
  const driver = module as { Statement?: { prototype?: Proto }; Database?: { prototype?: Proto } } | null | undefined;
  const statement = driver?.Statement?.prototype;
  if (!statement || typeof statement.run !== "function" || typeof statement.all !== "function") {
    deps.log.debug("a sqlite3 driver was found but its Statement does not run statements; not instrumenting");
    return false;
  }
  if (statement[MARK] === true) return true;
  for (const method of RUNS) wrap(statement, method, (self) => (self as { sql?: unknown }).sql, deps);
  // The database's own methods too, for a statement that does not compile: the driver answers that through the
  // callback the database's method was given, and never runs the statement. Not `map`, whose statement runs `all`
  // with a callback of its own.
  const database = driver?.Database?.prototype;
  if (database && database[MARK] !== true) {
    for (const method of [...RUNS, "exec"]) wrap(database, method, (_self, args) => args[0], deps);
    database[MARK] = true;
  }
  statement[MARK] = true;
  deps.log.debug(`instrumented sqlite3 ${version}`);
  return true;
}
