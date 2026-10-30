import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { currentContext, recordCallIn, recordErrorIn, recordOperationIn } from "../context.ts";
import { applicationEntry, basesOf, type From } from "../entry.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { FingerprintCache } from "../fingerprint.ts";
import type { Logger } from "../log.ts";
import { type Armed, armedTogether } from "./arm.ts";

/**
 * Postgres through postgres.js (`postgres`, the driver of Drizzle's `postgres-js` and of most Supabase backends),
 * observed as through `pg`: the queries a request runs, their time and their failures (ADR 0235).
 *
 * Every query postgres.js runs is a `Query`, a `Promise` of its own, and every one of them is executed by the first
 * call to `Query.prototype.handle` — from `then`, `catch`, `finally`, `execute` or `forEach`, in the context of the
 * code that awaited it. That is the one wrapper: it takes the request there, and the result is recorded into it when
 * the driver settles the query, from the connection's socket, where the context is whoever opened the connection.
 *
 * What it does not say, and why:
 *
 * - **The server.** A `Query` does not know its connection, and its connection's host and port are in closures of
 *   the driver's. Every postgres.js query is the dependency `postgres` with no target: a read replica and a primary
 *   reached through it are one dependency, not two.
 * - **The wait for a connection.** postgres.js queues a query that finds every connection busy inside its own
 *   closures, and the wait is part of the query's time.
 * - **A cursor read with `for await`.** Each page replaces the callbacks the query settles with, and the last one
 *   is never the one this observer wrapped. A cursor with a callback, and `forEach`, are counted.
 */

const MARK = Symbol.for("downtrace.postgresjs.instrumented");

/** The part of a `Query` this observer reads or wraps. Anything else about it is none of our business. */
interface QueryLike {
  executed?: unknown;
  resolve?: unknown;
  reject?: unknown;
  /** The text postgres.js sends, with a `$n` for each value: written when the query is built on a connection. */
  string?: unknown;
  /** The parts of the template the application wrote, or `[text]` for `sql.unsafe`. */
  strings?: unknown;
}

interface Proto extends Record<string, unknown> {
  [MARK]?: boolean;
}

export interface InstrumentPostgresJsDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at
   * debug, sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /** Where the query text becomes a fingerprint, read as Postgres. Absent means the text is never looked at. */
  fingerprints?: FingerprintCache | undefined;
  /** Where a thrown thing becomes a signature. Absent means errors are counted and not identified. */
  errors?: ErrorFingerprintCache | undefined;
}

/**
 * The text of the query: the one postgres.js built, or, for a query that failed before it reached a connection,
 * the template the application wrote with a `$n` where postgres.js would have put each value. Never a value: the
 * driver sends them as parameters.
 */
function textOf(query: QueryLike): string | undefined {
  if (typeof query.string === "string") return query.string;
  const strings = query.strings;
  if (!Array.isArray(strings) || strings.length === 0) return undefined;
  if (!strings.every((part) => typeof part === "string")) return undefined;
  return strings.reduce((text: string, part: string, i: number) => `${text}$${i}${part}`);
}

/**
 * Patches the `Query` of the postgres.js module the application loaded, ESM or CommonJS: the two are two modules
 * and two classes, and each is patched on its own. Returns whether there was anything to patch.
 */
export function patchPostgresJs(module: unknown, version: string, deps: InstrumentPostgresJsDeps): boolean {
  const proto = (module as { Query?: { prototype?: Proto } } | null | undefined)?.Query?.prototype;
  if (!proto || typeof proto.handle !== "function") {
    deps.log.debug("postgres found but Query.prototype.handle is not a function; not instrumenting");
    return false;
  }
  if (proto[MARK] === true) return true;
  const original = proto.handle as (...args: unknown[]) => unknown;
  proto.handle = function (this: QueryLike, ...args: unknown[]): unknown {
    // Only the first call executes the query; `then`, `catch` and `finally` call it again on every use. The read is
    // inside the `try`, because what a getter on the application's query throws is not the query's.
    try {
      if (this.executed !== true) observe(this, deps);
    } catch (err) {
      deps.internalError(err);
    }
    return original.apply(this, args);
  };
  proto[MARK] = true;
  deps.log.debug(`instrumented postgres ${version}`);
  return true;
}

/**
 * Takes the request the query is executed for, and wraps the two callbacks the driver settles it with, so that the
 * result is recorded into that request. A query outside a request is not wrapped at all.
 */
function observe(query: QueryLike, deps: InstrumentPostgresJsDeps): void {
  const ctx = currentContext();
  if (!ctx) return;
  const { resolve, reject } = query;
  if (typeof resolve !== "function" || typeof reject !== "function") return;
  const started = performance.now();
  let counted = false;
  const record = (failed: boolean, err?: unknown): void => {
    if (counted) return;
    counted = true;
    // This runs inside the driver's handling of the server's answer, before the application's continuation:
    // anything thrown here would be the driver's to deal with. Measuring is not worth breaking what is measured.
    try {
      const ended = performance.now();
      recordCallIn(ctx, "postgres", "", ended - started, failed);
      const sql = deps.fingerprints ? textOf(query) : undefined;
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
  };
  query.resolve = function (this: unknown, ...args: unknown[]): unknown {
    record(false);
    return resolve.apply(this, args);
  };
  query.reject = function (this: unknown, ...args: unknown[]): unknown {
    record(true, args[0]);
    return reject.apply(this, args);
  };
}

/**
 * The start-up half (ADR 0235). postgres.js is two modules in one package: `cjs/src/` for `require`, and `src/`
 * for `import`, which never enters the module cache `armDriver` reads (ADR 0209). So the start resolves the package
 * from the application's root and loads nothing, and the attach patches each copy its own way:
 *
 * - **CommonJS** as `pg` and `mysql2`: from the first request at which the application has loaded it, off the
 *   module cache, with a `require` that is a cache hit.
 * - **ESM** by importing the file the application's `import "postgres"` loads, by its URL, so that it is the same
 *   module and the same class. Not at start-up, where a tracker whose load hooks are registered after this observer
 *   would never see the file loaded (ESC-16), but from the first request, on the next turn of the loop, outside
 *   that request's path (invariant 1). A query that starts before the import resolves is not counted. Under
 *   `downtrace check` (`early`) the import starts at start-up: the first request of a test file is a test, and
 *   losing it would hide a regression from both runs alike.
 */
export function armPostgresJs(
  deps: InstrumentPostgresJsDeps & { from?: From | undefined; early?: boolean | undefined },
): Armed {
  // Each copy a base resolves, once: under `check` the entry and the project may resolve one copy or two.
  const copies = new Map<string, Copy>();
  for (const base of basesOf(deps.from ?? applicationEntry())) {
    const copy = copyOf(base, deps.log);
    if (copy !== undefined && !copies.has(copy.root)) copies.set(copy.root, copy);
  }
  if (copies.size === 0) {
    deps.log.debug("postgres is not resolvable from the application's root; not instrumenting");
    return { state: "unavailable", attach: () => true };
  }
  return armedTogether([...copies.values()].map((copy) => armCopy(copy, deps)));
}

/** A copy of postgres.js: its directory, the version it says, and the `require` that found it. */
interface Copy {
  root: string;
  version: string;
  require: NodeRequire;
}

/** The postgres.js `from` resolves, or nothing. Resolves and reads its `package.json`; loads nothing of it. */
function copyOf(from: string, log: Logger): Copy | undefined {
  const require = createRequire(from);
  try {
    // `default` is the condition `require` meets in its exports, and it names `cjs/src/index.js`.
    const root = path.resolve(path.dirname(require.resolve("postgres")), "..", "..");
    const pkg = require(path.join(root, "package.json")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "postgres") {
      log.debug("postgres resolved to a package of another name; not instrumenting");
      return undefined;
    }
    return { root, version: typeof pkg.version === "string" ? pkg.version : "unknown", require };
  } catch {
    return undefined;
  }
}

function armCopy(
  { root, version, require }: Copy,
  deps: InstrumentPostgresJsDeps & { early?: boolean | undefined },
): Armed {
  const cjs = path.join(root, "cjs", "src", "query.js");
  const esm = pathToFileURL(path.join(root, "src", "query.js")).href;
  let cjsDone = false;
  // undefined: not asked for yet; false: in flight; true: settled, patched or not.
  let esmDone: boolean | undefined;
  const importEsm = (): void => {
    esmDone = false;
    setImmediate(() => {
      import(esm).then(
        (module: unknown) => {
          esmDone = true;
          try {
            patchPostgresJs(module, version, deps);
          } catch (err) {
            deps.internalError(err);
          }
        },
        (err: unknown) => {
          esmDone = true;
          deps.internalError(err);
        },
      );
    });
  };
  if (deps.early === true) importEsm();

  const attach = (): boolean => {
    if (esmDone === undefined) importEsm();
    if (!cjsDone && require.cache[cjs] !== undefined) {
      cjsDone = true;
      try {
        patchPostgresJs(require(cjs), version, deps);
      } catch (err) {
        deps.internalError(err);
      }
    }
    // An application that imports the ESM copy never loads the CommonJS one, and pays this property read for as
    // long as it answers requests, as one that never loads `pg` does (ADR 0209).
    return cjsDone && esmDone === true;
  };
  return { state: "on", attach };
}
