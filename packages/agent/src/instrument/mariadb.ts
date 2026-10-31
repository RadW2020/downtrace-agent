import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  currentContext,
  type RequestContext,
  recordCallIn,
  recordErrorIn,
  recordOperationIn,
  recordWaitIn,
  runIn,
} from "../context.ts";
import { applicationEntry, basesOf, type From } from "../entry.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import type { FingerprintCache } from "../fingerprint.ts";
import type { Logger } from "../log.ts";
import { type Armed, armedTogether, whenRequired } from "./arm.ts";

/**
 * MySQL and MariaDB through `mariadb`, the connector MariaDB publishes: the driver Prisma's adapter for both
 * databases queries through (`@prisma/adapter-mariadb`, which Prisma 7 needs), and Sequelize's `mariadb` dialect.
 * Observed as `mysql2` is (`mysql.ts`): the queries a request runs, their time and their failures, and how long it
 * waited for a connection from the pool; the dependency is `mysql`, whichever of the two servers answers.
 *
 * Every API of the driver — promises, callbacks, a pool, a single connection — runs a statement through one class,
 * the connection in `lib/connection.js`, with the same three arguments: what to run, and the two callbacks the
 * command settles with (`query`, and from 3.4 `prepareExecute` and `batch`). That is the wrapper, beside two more:
 * the callback API's `query`, which builds its command itself (`ConnectionCallback._QUERY_CMD`, which its pool
 * calls too), and the pool in `lib/pool.js`. Before 3.0.1 `query` takes other arguments, and nothing is patched.
 *
 * What it does not say, and why:
 *
 * - **What the connection runs for itself while it opens**: `SET NAMES`, the session's variables. A pool opens a
 *   connection inside whichever request found none free, and those statements are the driver's, not that request's.
 *   A statement is counted from the moment the connection is ready.
 * - **`queryStream`**, which hands its command to the connection directly, and `execute` and `batch` before 3.4,
 *   which return a promise of their own: a handler on a promise the application may leave unhandled would change what
 *   the application sees (invariant 1).
 * - **The CommonJS build of 3.5.3 and later** (`dist/promise.cjs`), which is one bundle that exports none of its
 *   classes: an application that `require`s the driver from there is not observed, and the log says so. One that
 *   imports it, and Prisma's adapter from an ES module, load `lib/`, which is. Prisma's adapter from CommonJS — a
 *   NestJS application on Prisma 7.10 — is observed one floor up, at the adapter (`watchPrismaMariadb`).
 */

const MARK = Symbol.for("downtrace.mariadb.instrumented");
const POOL_MARK = Symbol.for("downtrace.mariadb.pool.instrumented");
const CALLBACK_MARK = Symbol.for("downtrace.mariadb.callback.instrumented");
const ADAPTER_MARK = Symbol.for("downtrace.mariadb.prisma.instrumented");

/** Prisma's driver adapter for MySQL and MariaDB, by the name an application requires it with. */
const PRISMA_ADAPTER = "@prisma/adapter-mariadb";

/**
 * The driver's `CONNECTED`, the same number in every version from 3 (`lib/const/connection_status.js`): before it
 * the connection is still opening, and what it runs is its own.
 */
const CONNECTED = 5;

/** The methods of the connection that run a statement with `(what, resolve, reject)`. */
const STATEMENTS = ["query", "prepareExecute", "batch"] as const;

interface Proto extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
  [POOL_MARK]?: boolean;
  [CALLBACK_MARK]?: boolean;
  [ADAPTER_MARK]?: boolean;
}

export interface InstrumentMariadbDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at debug,
   * sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /** Where the query text becomes a fingerprint, read as MySQL's (ADR 0086). Absent: the text is never looked at. */
  fingerprints?: FingerprintCache | undefined;
  /** Where a thrown thing becomes a signature. Absent means errors are counted and not identified. */
  errors?: ErrorFingerprintCache | undefined;
}

function prototypeOf(cls: unknown): Proto | undefined {
  const proto = (cls as { prototype?: unknown } | null | undefined)?.prototype;
  return proto !== null && typeof proto === "object" ? (proto as Proto) : undefined;
}

/**
 * Patches the connection class of the driver the application loaded: `query`, and `prepareExecute` and `batch` where
 * they take the same three arguments. Returns whether there was anything to patch.
 */
export function patchMariadbConnection(Connection: unknown, version: string, deps: InstrumentMariadbDeps): boolean {
  const proto = prototypeOf(Connection);
  if (proto?.[MARK] === true) return true;
  if (!proto || typeof proto.query !== "function" || (proto.query as () => unknown).length !== 3) {
    deps.log.debug("mariadb found but its connection has no query(cmdParam, resolve, reject); not instrumenting");
    return false;
  }
  for (const method of STATEMENTS) {
    const original = proto[method];
    if (typeof original === "function" && original.length === 3) wrapStatement(proto, method, deps);
  }
  proto[MARK] = true;
  deps.log.debug(`instrumented mariadb ${version}`);
  return true;
}

/** Patches the pool class of that driver: the wait for a connection, and the request the connection is handed to. */
export function patchMariadbPool(Pool: unknown, deps: InstrumentMariadbDeps): boolean {
  const proto = prototypeOf(Pool);
  if (!proto || typeof proto.getConnection !== "function") {
    deps.log.debug("mariadb found but its pool has no getConnection; the wait for a connection is not timed");
    return false;
  }
  if (proto[POOL_MARK] === true) return true;
  wrapGetConnection(proto, deps);
  proto[POOL_MARK] = true;
  return true;
}

/**
 * Patches the callback API's connection class, whose `query` builds its command and hands it to the connection
 * without going through the connection's `query`: the static `_QUERY_CMD`, which the callback API's pool calls too.
 */
export function patchMariadbCallback(ConnectionCallback: unknown, deps: InstrumentMariadbDeps): boolean {
  const cls = ConnectionCallback as Proto | null | undefined;
  if (cls?.[CALLBACK_MARK] === true) return true;
  if (!cls || typeof cls._QUERY_CMD !== "function") {
    deps.log.debug("mariadb found but its callback API has no _QUERY_CMD; its queries are not observed");
    return false;
  }
  const original = cls._QUERY_CMD as (...args: unknown[]) => unknown;
  cls._QUERY_CMD = function (this: unknown, ...args: unknown[]): unknown {
    let afterwards: (() => void) | undefined;
    try {
      afterwards = observeCallback(args[0], args[1], deps);
    } catch (err) {
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
  cls[CALLBACK_MARK] = true;
  return true;
}

/**
 * Wraps a method that runs a statement, so that the statement counts towards the request that asked for it.
 *
 * Only the instrumentation's own work sits inside the `try`. The callbacks are replaced last, so a failure before
 * that leaves the arguments as the application's code wrote them; the driver is called once, after the `try`, and
 * what it throws is the application's (gh-662).
 */
function wrapStatement(proto: Proto, method: (typeof STATEMENTS)[number], deps: InstrumentMariadbDeps): void {
  const original = proto[method] as (...args: unknown[]) => unknown;
  proto[method] = function (this: unknown, ...args: unknown[]): unknown {
    try {
      observe(this, args, deps);
    } catch (err) {
      deps.internalError(err);
    }
    return original.apply(this, args);
  };
}

/**
 * Takes the request that is asking, starts the clock, and puts in place of the two callbacks two that record the
 * statement and then call them in that request: the driver settles a command from the connection's socket, whose
 * context is whichever request opened it, and a callback that asks the next query from there would give it to that
 * request (gh-89).
 */
function observe(connection: unknown, args: unknown[], deps: InstrumentMariadbDeps): void {
  const [command, resolve, reject] = args;
  if (typeof resolve !== "function" || typeof reject !== "function") return;
  const begun = begin(connection, command, deps);
  if (begun === undefined) return;
  const { ctx, settle } = begun;
  args[1] = function (this: unknown, ...result: unknown[]): unknown {
    settle(false, undefined);
    return runIn(ctx, () => (resolve as (...a: unknown[]) => unknown).apply(this, result));
  };
  args[2] = function (this: unknown, ...result: unknown[]): unknown {
    settle(true, result[0]);
    return runIn(ctx, () => (reject as (...a: unknown[]) => unknown).apply(this, result));
  };
}

/**
 * The same for the callback API's query, whose one callback takes the error first. One with no callback is the
 * event form, which settles on events whose listeners are the application's: it is counted when it is issued, with
 * no failure, as `mysql2`'s is.
 */
function observeCallback(connection: unknown, command: unknown, deps: InstrumentMariadbDeps): (() => void) | undefined {
  const begun = begin(connection, command, deps);
  if (begun === undefined) return undefined;
  const { ctx, settle } = begun;
  const holder = command as { callback?: unknown };
  const callback = holder.callback;
  if (typeof callback !== "function") return () => settle(false, undefined);
  holder.callback = function (this: unknown, ...result: unknown[]): unknown {
    const err = result[0];
    settle(err !== null && err !== undefined, err);
    return runIn(ctx, () => (callback as (...a: unknown[]) => unknown).apply(this, result));
  };
  return undefined;
}

/**
 * Takes the request that is asking and starts the clock, for a statement on a connection that is ready: what one
 * runs while it opens is its own. Returns the request, and what records the statement once, when it ends.
 */
function begin(
  connection: unknown,
  command: unknown,
  deps: InstrumentMariadbDeps,
): { ctx: RequestContext; settle: (failed: boolean, err: unknown) => void } | undefined {
  const ctx = currentContext();
  if (!ctx) return undefined;
  const status = (connection as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status < CONNECTED) return undefined;
  const target = targetOf((connection as { opts?: unknown } | null)?.opts);
  return { ctx, settle: started(ctx, target, command, deps) };
}

/** Starts the clock on a statement of `ctx`, and returns what records it once, when it ends. */
function started(
  ctx: RequestContext,
  target: string,
  command: unknown,
  deps: InstrumentMariadbDeps,
): (failed: boolean, err: unknown) => void {
  const { fingerprints, errors, internalError } = deps;
  const sql = fingerprints ? textOf(command) : undefined;
  const started = performance.now();
  let counted = false;
  const settle = (failed: boolean, err: unknown): void => {
    if (counted) return;
    counted = true;
    // This runs inside the driver's handling of the server's answer: anything thrown here would be the driver's to
    // deal with. Measuring is not worth breaking what is measured (invariants 1 and 2).
    try {
      const ended = performance.now();
      recordCallIn(ctx, "mysql", target, ended - started, failed);
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
  return settle;
}

/**
 * Times how long a request waits for a connection from the pool, and hands the connection to that request: a pool
 * with nothing free calls the callback from whoever gave a connection back, and the query `pool.query()` runs from
 * there would be asked by that other request (gh-89).
 */
function wrapGetConnection(proto: Proto, deps: InstrumentMariadbDeps): void {
  const original = proto.getConnection as (...args: unknown[]) => unknown;
  proto.getConnection = function (this: unknown, ...args: unknown[]): unknown {
    try {
      const last = args.at(-1);
      const ctx = typeof last === "function" ? currentContext() : undefined;
      if (ctx) {
        const callback = last as (...result: unknown[]) => unknown;
        const started = performance.now();
        const pool = this;
        args[args.length - 1] = function (this: unknown, ...result: unknown[]): unknown {
          try {
            // The connection's target when it came, the pool's when it did not: the same string either way.
            const given = (result[1] as { opts?: unknown } | null | undefined)?.opts;
            const target = result[0] ? targetOfPool(pool) : targetOf(given) || targetOfPool(pool);
            recordWaitIn(ctx, "mysql", target, performance.now() - started);
          } catch (err) {
            deps.internalError(err);
          }
          return runIn(ctx, () => callback.apply(this, result));
        };
      }
    } catch (err) {
      deps.internalError(err);
    }
    return original.apply(this, args);
  };
}

/** The text of a statement as the application wrote it: the driver formats the values in after this. */
function textOf(command: unknown): string | undefined {
  const sql = (command as { sql?: unknown } | null | undefined)?.sql;
  return typeof sql === "string" ? sql : undefined;
}

/**
 * Where a connection points: its socket, or its host and port, which the driver fills in when the application did
 * not (`localhost`, 3306) — the string `mysql2`'s observer makes of the same server. Never the user, the password or
 * the database.
 */
function targetOf(opts: unknown): string {
  if (!opts || typeof opts !== "object") return "";
  const { host, port, socketPath } = opts as { host?: unknown; port?: unknown; socketPath?: unknown };
  if (typeof socketPath === "string" && socketPath !== "") return socketPath;
  if (typeof host !== "string" || host === "") return "";
  return typeof port === "number" ? `${host}:${port}` : host;
}

function targetOfPool(pool: unknown): string {
  return targetOf((pool as { opts?: { connOptions?: unknown } } | null | undefined)?.opts?.connOptions);
}

/** Whether the `mariadb` that `file` requires is the CommonJS bundle of 3.5.3 and later, whose classes are its own. */
function requiresBundle(file: string): boolean {
  try {
    return createRequire(file).resolve("mariadb").endsWith(path.join("dist", "promise.cjs"));
  } catch {
    return false;
  }
}

/** Whether the Prisma adapter `from` requires queries through that bundle: then it is observed at the adapter. */
export function prismaAdapterOverBundle(from: string): boolean {
  try {
    return requiresBundle(createRequire(from).resolve(PRISMA_ADAPTER));
  } catch {
    return false;
  }
}

/**
 * Observes Prisma's adapter for MySQL and MariaDB where the driver under it cannot be: required from CommonJS, over the
 * bundle 3.5.3 and later ship for `require` — a NestJS application on Prisma 7.10. Every query Prisma sends goes
 * through the adapter's `performIO`, on a class the adapter does not export; the adapter its factory's `connect` hands
 * over is the way to it. So the factory is patched when the adapter is loaded, which Node announces on its
 * `module.require` channel (as it announces Jest's runtime), or at once when the application loaded it already: a
 * NestJS application connects at start-up, before any request, and the first request is too late (ADR 0209).
 *
 * Over the driver's own modules — up to 3.4, or imported — the driver's observer counts those queries, and the
 * adapter is left alone. What this does not say: the server, which the bundle keeps to itself (the dependency `mysql`
 * with no target, as postgres.js's); the `BEGIN` and `COMMIT` of a transaction, which the adapter sends on the
 * connection itself; and the wait for a connection. Node 20 has no `module.require` channel: there, only an adapter
 * loaded before the instrumentation started is observed. Returns what stops listening.
 */
export function watchPrismaMariadb(deps: InstrumentMariadbDeps & { from?: From | undefined }): () => void {
  return whenRequired({
    name: PRISMA_ADAPTER,
    from: deps.from ?? applicationEntry(),
    accept: requiresBundle,
    patch: (exports) => {
      patchPrismaMariadb(exports, deps);
    },
    internalError: deps.internalError,
  });
}

/**
 * Patches the factory Prisma's adapter exports: its `connect`, whose adapter is patched before the application gets
 * it. The promise the application gets settles as Prisma's does, with the same adapter or the same error.
 */
export function patchPrismaMariadb(exports: unknown, deps: InstrumentMariadbDeps): boolean {
  const proto = prototypeOf((exports as { PrismaMariaDb?: unknown } | null | undefined)?.PrismaMariaDb);
  if (proto?.[ADAPTER_MARK] === true) return true;
  if (!proto || typeof proto.connect !== "function") {
    deps.log.debug(`${PRISMA_ADAPTER} found but its PrismaMariaDb has no connect; its queries are not observed`);
    return false;
  }
  const connect = proto.connect as (...args: unknown[]) => unknown;
  proto.connect = function (this: unknown, ...args: unknown[]): unknown {
    const connecting = connect.apply(this, args);
    if (!isThenable(connecting)) return connecting;
    return connecting.then((adapter: unknown) => {
      try {
        patchQueryable(adapter, deps);
      } catch (err) {
        deps.internalError(err);
      }
      return adapter;
    });
  };
  proto[ADAPTER_MARK] = true;
  deps.log.debug(`instrumented ${PRISMA_ADAPTER}, over the CommonJS bundle of mariadb`);
  return true;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Wraps `performIO` on the class of the adapter that defines it, which its transactions extend too: the query, its
 * time and its failure, in the request that asked. What it returns is the promise Prisma awaits, settled as the
 * adapter's own.
 */
function patchQueryable(adapter: unknown, deps: InstrumentMariadbDeps): void {
  let proto = adapter !== null && typeof adapter === "object" ? (Object.getPrototypeOf(adapter) as Proto | null) : null;
  while (proto !== null && proto !== Object.prototype && !Object.hasOwn(proto, "performIO")) {
    proto = Object.getPrototypeOf(proto) as Proto | null;
  }
  if (proto === null || proto === Object.prototype || typeof proto.performIO !== "function") {
    deps.log.debug(`${PRISMA_ADAPTER} connected an adapter with no performIO; its queries are not observed`);
    return;
  }
  if (proto[ADAPTER_MARK] === true) return;
  const performIO = proto.performIO as (...args: unknown[]) => unknown;
  proto.performIO = function (this: unknown, ...args: unknown[]): unknown {
    let settle: ((failed: boolean, err: unknown) => void) | undefined;
    try {
      const ctx = currentContext();
      if (ctx) settle = started(ctx, "", args[0], deps);
    } catch (err) {
      deps.internalError(err);
    }
    const result = performIO.apply(this, args);
    if (settle === undefined || !isThenable(result)) return result;
    const record = settle;
    return result.then(
      (value: unknown) => {
        record(false, undefined);
        return value;
      },
      (err: unknown) => {
        record(true, err);
        throw err;
      },
    );
  };
  proto[ADAPTER_MARK] = true;
}

/** A copy of the driver: its directory, its version, whether its `lib/` is ESM, and the `require` that found it. */
interface Copy {
  root: string;
  version: string;
  esm: boolean;
  require: NodeRequire;
}

/** The packages that bring a `mariadb` of their own, pinned to a version (DT-92). */
const BESIDE = ["@prisma/adapter-mariadb", "@mikro-orm/mariadb"] as const;

/**
 * The start-up half (ADR 0209), as postgres.js's (ADR 0235): resolve every copy from the application's root, and
 * from the packages that bring one, load nothing, and patch each its own way from the first request:
 *
 * - **Up to 3.4**, CommonJS: off the module cache, once the application has loaded it, with a `require` that is a
 *   cache hit.
 * - **From 3.5**, ESM: by importing `lib/connection.js` and `lib/pool.js` by their URL, the modules the application's
 *   `import` loads, on the next turn of the loop after the first request; under `check` (`early`) from the start.
 *   A query that starts before the import resolves is not counted.
 */
export function armMariadb(
  deps: InstrumentMariadbDeps & { from?: From | undefined; early?: boolean | undefined },
): Armed {
  const copies = new Map<string, Copy>();
  const keep = (copy: Copy | undefined): void => {
    if (copy !== undefined && !copies.has(copy.root)) copies.set(copy.root, copy);
  };
  const bases = basesOf(deps.from ?? applicationEntry());
  for (const base of bases) keep(copyOf(base, deps.log));
  for (const name of BESIDE) {
    for (const base of bases) {
      let from: string;
      try {
        from = createRequire(base).resolve(name);
      } catch {
        continue; // most applications do not have it, and that is not worth a line
      }
      keep(copyOf(from, deps.log));
    }
  }
  if (copies.size === 0) {
    deps.log.debug("mariadb is not resolvable from the application's root; not instrumenting");
    return { state: "unavailable", attach: () => true };
  }
  return armedTogether([...copies.values()].map((copy) => (copy.esm ? armEsm(copy, deps) : armCommonJs(copy, deps))));
}

/** The `mariadb` that `from` resolves, or nothing. Reads its `package.json`, and loads nothing of it. */
function copyOf(from: string, log: Logger): Copy | undefined {
  const require = createRequire(from);
  try {
    // 3.4 and before resolve to `promise.js` at the root; 3.5.3 and after, for `require`, to `dist/promise.cjs`.
    let root = path.dirname(require.resolve("mariadb"));
    if (path.basename(root) === "dist") root = path.dirname(root);
    const pkg = require(path.join(root, "package.json")) as { name?: unknown; version?: unknown; type?: unknown };
    if (pkg.name !== "mariadb") {
      log.debug("mariadb resolved to a package of another name; not instrumenting");
      return undefined;
    }
    return {
      root,
      version: typeof pkg.version === "string" ? pkg.version : "unknown",
      esm: pkg.type === "module",
      require,
    };
  } catch {
    return undefined;
  }
}

function armCommonJs({ root, version, require }: Copy, deps: InstrumentMariadbDeps): Armed {
  const lib = (file: string): string => path.join(root, "lib", file);
  // The connection and the pool are loaded by either of the driver's entries, so they are there together, or
  // neither is; the callback API's class only by `mariadb/callback`, and so by then or never.
  const modules = [
    { file: lib("connection.js"), patch: (m: unknown) => patchMariadbConnection(m, version, deps), done: false },
    { file: lib("pool.js"), patch: (m: unknown) => patchMariadbPool(m, deps), done: false },
    { file: lib("connection-callback.js"), patch: (m: unknown) => patchMariadbCallback(m, deps), done: false },
  ];
  const attach = (): boolean => {
    for (const module of modules) {
      // Loaded, as `armDriver` asks (ADR 0246).
      if (module.done || require.cache[module.file]?.loaded !== true) continue;
      module.done = true;
      try {
        module.patch(require(module.file));
      } catch (err) {
        deps.internalError(err);
      }
    }
    return modules[0]?.done === true && modules[1]?.done === true;
  };
  return { state: "on", attach, atLoad: attach };
}

function armEsm(
  { root, version, require }: Copy,
  deps: InstrumentMariadbDeps & { early?: boolean | undefined },
): Armed {
  const url = (file: string): string => pathToFileURL(path.join(root, "lib", file)).href;
  // undefined: not asked for yet; false: in flight; true: settled, patched or not.
  let done: boolean | undefined;
  const importEsm = (): void => {
    done = false;
    setImmediate(() => {
      Promise.all([import(url("connection.js")), import(url("pool.js")), import(url("connection-callback.js"))]).then(
        ([connection, pool, callback]: unknown[]) => {
          done = true;
          try {
            patchMariadbConnection((connection as { default?: unknown }).default, version, deps);
            patchMariadbPool((pool as { default?: unknown }).default, deps);
            patchMariadbCallback((callback as { default?: unknown }).default, deps);
            // An application that requires the driver loads the bundle instead, whose classes are its own.
            const bundle = ["promise.cjs", "callback.cjs"].some(
              (file) => require.cache[path.join(root, "dist", file)] !== undefined,
            );
            if (bundle) {
              deps.log.debug(
                `mariadb ${version} is required from its CommonJS bundle, which exports none of its classes; its queries are not observed`,
              );
            }
          } catch (err) {
            deps.internalError(err);
          }
        },
        (err: unknown) => {
          done = true;
          deps.internalError(err);
        },
      );
    });
  };
  if (deps.early === true) importEsm();
  const attach = (): boolean => {
    if (done === undefined) importEsm();
    return done === true;
  };
  return { state: "on", attach };
}
