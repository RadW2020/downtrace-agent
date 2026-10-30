import path from "node:path";
import { performance } from "node:perf_hooks";
import { currentContext, type RequestContext, recordCallIn, recordErrorIn, recordOperationIn } from "../context.ts";
import { applicationEntry, type From } from "../entry.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { FingerprintCache } from "../fingerprint.ts";
import type { Logger } from "../log.ts";
import { type Armed, armDriver, armedTogether } from "./arm.ts";
import { patchSqlite3 } from "./sqlite3.ts";

/**
 * SQLite in the process (ADR 0239): the statements a request runs through `better-sqlite3`, or through `libsql`, the
 * driver `@libsql/client` opens a file with — and so Drizzle, Knex and Prisma 7's adapters on either. Their time and
 * their failures, under the dependency `sqlite`, with no target.
 *
 * Both drivers have one shape, better-sqlite3's: a `Database` whose `prepare(sql)` gives a statement, and a statement
 * that runs with `run`, `get`, `all` or `iterate`; and `exec(sql)` for text with no statement to keep. Every one of
 * them runs synchronously, in the context of the code that called it, so the wrapper reads the request's context and
 * the clock around the call, and nothing waits for anything.
 *
 * What it does not say, and why:
 *
 * - **Which file.** A database's path is the machine's, and can hold a person's name; every file is one `sqlite`.
 * - **Preparing.** Compiling a statement is not running it, and a statement prepared once at start-up and run in
 *   every request is the ordinary way to use these drivers: what is counted is each run.
 * - **The rows of `iterate`.** It counts the statement once, when the loop starts; the time the loop spends reading
 *   rows is the loop's.
 * - **A libsql statement prepared before the instrumentation was there.** libsql keeps no text of a statement, so
 *   one the wrapper did not see prepared is counted against the dependency and has no operation to be. better-sqlite3
 *   keeps its text, as `source`, and its class is the addon's, patched as soon as the driver is.
 */

const MARK = Symbol.for("downtrace.sqlite.instrumented");

/** The methods of a statement that run it. */
const RUNS = ["run", "get", "all", "iterate"] as const;

/** The text of each statement a libsql `prepare` gave, which keeps none of its own. */
const texts = new WeakMap<object, string>();

interface Proto extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
}

export interface InstrumentSqliteDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at debug,
   * sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /**
   * Where the statement's text becomes a fingerprint, **read as SQLite**: a cache made for another dialect would keep
   * what SQLite reads as a value. Absent means calls are counted against the dependency and not named.
   */
  fingerprints?: FingerprintCache | undefined;
  /** Where a thrown thing becomes a signature. Absent means errors are counted and not identified. */
  errors?: ErrorFingerprintCache | undefined;
}

/** The SQL of a statement: better-sqlite3 says it as `source`, and libsql's is what its `prepare` was given. */
function textOf(statement: unknown): string | undefined {
  if (statement === null || typeof statement !== "object") return undefined;
  const source = (statement as { source?: unknown }).source;
  return typeof source === "string" ? source : texts.get(statement);
}

/**
 * How many observed runs are on the stack. A driver that runs a statement through another of its own methods — libsql's
 * `all` loops over its `iterate` — ran one statement, and the run inside is not counted again. Everything here is
 * synchronous, so nothing else runs while the count is up.
 */
let running = 0;

/** Runs one statement, or one `exec`, and records it into the request that asked, when one did. */
function observed(text: () => string | undefined, run: () => unknown, deps: InstrumentSqliteDeps): unknown {
  if (running > 0) return run();
  const ctx = currentContext();
  if (!ctx) return run();
  let sql: string | undefined;
  try {
    sql = text();
  } catch (err) {
    deps.internalError(err);
  }
  const started = performance.now();
  let result: unknown;
  running += 1;
  try {
    result = run();
  } catch (err) {
    running -= 1;
    record(ctx, sql, started, err, deps);
    throw err;
  }
  running -= 1;
  record(ctx, sql, started, undefined, deps);
  return result;
}

function record(
  ctx: RequestContext,
  sql: string | undefined,
  started: number,
  err: unknown,
  deps: InstrumentSqliteDeps,
): void {
  // Between the driver's answer and the application's next line: what is thrown here would be the statement's to the
  // application. Measuring is not worth breaking what is measured (invariant 2).
  try {
    const ended = performance.now();
    const failed = err !== undefined;
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

/** Wraps the methods that run a statement, on the class every statement of the driver shares. */
function patchStatement(proto: Proto, deps: InstrumentSqliteDeps): void {
  if (proto[MARK] === true) return;
  for (const name of RUNS) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = function (this: unknown, ...args: unknown[]): unknown {
      return observed(
        () => textOf(this),
        () => original.apply(this, args),
        deps,
      );
    };
  }
  proto[MARK] = true;
}

/**
 * Patches a SQLite driver's `Database`, better-sqlite3's or libsql's, and the class of its statements: the one given,
 * or the first a `prepare` returns. Returns whether there was anything to patch. The module is handed over already
 * loaded: the production start-up does not load it (ADR 0209, `armSqlite`), and a test gives one.
 */
export function patchSqlite(
  module: unknown,
  version: string,
  deps: InstrumentSqliteDeps,
  statement?: object | undefined,
): boolean {
  const proto = typeof module === "function" ? (module.prototype as Proto | undefined) : undefined;
  if (!proto || typeof proto.prepare !== "function") {
    deps.log.debug("a SQLite driver was found but its Database has no prepare; not instrumenting");
    return false;
  }
  if (statement !== undefined) patchStatement(statement as Proto, deps);
  if (proto[MARK] === true) return true;
  const prepare = proto.prepare as (this: unknown, ...args: unknown[]) => unknown;
  proto.prepare = function (this: unknown, ...args: unknown[]): unknown {
    const prepared = prepare.apply(this, args);
    try {
      if (prepared !== null && typeof prepared === "object") {
        if (typeof args[0] === "string" && typeof (prepared as { source?: unknown }).source !== "string") {
          texts.set(prepared, args[0]);
        }
        patchStatement(Object.getPrototypeOf(prepared) as Proto, deps);
      }
    } catch (err) {
      deps.internalError(err);
    }
    return prepared;
  };
  if (typeof proto.exec === "function") {
    const exec = proto.exec as (this: unknown, ...args: unknown[]) => unknown;
    proto.exec = function (this: unknown, ...args: unknown[]): unknown {
      return observed(
        () => (typeof args[0] === "string" ? args[0] : undefined),
        () => exec.apply(this, args),
        deps,
      );
    };
  }
  proto[MARK] = true;
  deps.log.debug(`instrumented a SQLite driver, ${version}`);
  return true;
}

/**
 * The class of better-sqlite3's statements, from its native addon in the module cache: there once the application has
 * opened a database, and the only way to reach the statements it prepared at start-up, which no later `prepare` hands
 * over. Undefined when it is not loaded yet, or not where the package keeps it.
 */
export function addonStatementOf(resolved: string, cache: NodeJS.Require["cache"]): object | undefined {
  // `lib/index.js`, and the addon under the package's `build/`.
  const root = path.dirname(path.dirname(resolved)) + path.sep;
  for (const [file, loaded] of Object.entries(cache)) {
    if (!file.startsWith(root) || !file.endsWith(".node")) continue;
    const statement = (loaded?.exports as { Statement?: { prototype?: unknown } } | undefined)?.Statement;
    if (typeof statement === "function" && typeof statement.prototype === "object" && statement.prototype !== null) {
      return statement.prototype;
    }
  }
  return undefined;
}

/**
 * The start-up half, as `pg`'s: resolve each driver from the application's root, and from the packages that bring
 * their own — `@libsql/client` its libsql, Prisma's adapter its better-sqlite3 (DT-92), MikroORM's packages whichever
 * they pin — load nothing, and patch from the start of the first request at which the application has loaded one
 * (ADR 0209). All three ship only CommonJS, so an `import` puts them in the module cache too.
 */
export function armSqlite(deps: InstrumentSqliteDeps & { from?: From | undefined }): Armed {
  const from = deps.from ?? applicationEntry();
  // `@mikro-orm/sqlite` is on better-sqlite3 from 7, and on node-sqlite3 before.
  const better = armDriver<unknown>({
    driver: "better-sqlite3",
    from,
    beside: ["@prisma/adapter-better-sqlite3", "@mikro-orm/sqlite", "@mikro-orm/better-sqlite"],
    log: deps.log,
    internalError: deps.internalError,
    patch: (module, version, require, resolved) => {
      patchSqlite(module, version, deps, addonStatementOf(resolved, require.cache));
    },
  });
  const libsql = armDriver<unknown>({
    driver: "libsql",
    from,
    beside: ["@libsql/client", "@mikro-orm/libsql"],
    log: deps.log,
    internalError: deps.internalError,
    patch: (module, version) => {
      patchSqlite(module, version, deps);
    },
  });
  // node-sqlite3, the callback driver Knex and Sequelize open SQLite with: both ask the application to install it.
  // MikroORM before 7 brings its own.
  const sqlite3 = armDriver<unknown>({
    driver: "sqlite3",
    from,
    beside: ["@mikro-orm/sqlite"],
    log: deps.log,
    internalError: deps.internalError,
    patch: (module, version) => {
      patchSqlite3(module, version, deps);
    },
  });
  return armedTogether([better, libsql, sqlite3]);
}
