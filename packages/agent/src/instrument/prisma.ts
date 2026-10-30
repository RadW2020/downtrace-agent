import Module, { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import {
  currentContext,
  type DependencyKind,
  type RequestContext,
  recordCallIn,
  recordErrorIn,
  recordOperationIn,
} from "../context.ts";
import { applicationEntry, basesOf, type From } from "../entry.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import { type Fingerprint, type FingerprintCache, hash64 } from "../fingerprint.ts";
import type { Logger } from "../log.ts";
import type { Armed } from "./arm.ts";

/**
 * Prisma 4 to 6 through its engine (ADR 0241): the operations a request runs through a client `prisma-client-js`
 * generated, under the dependency its datasource is — `findMany Post`, `create User`, and the SQL of a raw query — with
 * their time and their failures. Until Prisma 7 a client queries through an engine of its own, which talks to the
 * database with no driver of Node's, so no other observer sees any of it: every route of such an application was
 * `nothing-observed`, and the loop that runs a `findMany` per item, which is the N+1 a person and a coding agent write
 * most, was the one thing `check` could not see.
 *
 * Every operation of a generated client goes through one method of its class, `_executeRequest`, with the action, the
 * model and the arguments: the operations of a `$transaction`, of an interactive one, of a client `$extends` made, and
 * the raw queries. It is what the code asked for: an `include` is one operation however many statements the engine
 * runs for it, and the `findUnique`s the client batches in one tick are each one, as the code wrote them. A middleware
 * that answers without the engine never reaches it, and is not counted.
 *
 * What it does not see, and why:
 *
 * - **A client with a driver adapter.** Its SQL goes through the driver, whose own observer counts it, as Prisma 7's
 *   does: counting it here too would count it twice. It is left alone.
 * - **SQL Server.** The protocol has no dependency for it.
 * - **A client whose class nothing outside its runtime holds:** one Prisma 6's `prisma-client` generator wrote, which
 *   imports the runtime's ES module, and one a bundle inlined with its runtime. The class is reached from the module
 *   cache, and under `check` from the runtime as Node loads it (ADR 0243): one Vitest runs from the project's directory
 *   is seen there, and only there.
 */

const MARK = Symbol.for("downtrace.prisma.instrumented");

/**
 * The dependency each provider a datasource names is. CockroachDB speaks Postgres's protocol and Postgres's SQL, as
 * Prisma reads it.
 */
export const PRISMA_PROVIDERS = {
  postgresql: "postgres",
  cockroachdb: "postgres",
  mysql: "mysql",
  sqlite: "sqlite",
  mongodb: "mongodb",
} as const satisfies Record<string, DependencyKind>;

type PrismaDependency = (typeof PRISMA_PROVIDERS)[keyof typeof PRISMA_PROVIDERS];
type SqlDependency = Exclude<PrismaDependency, "mongodb">;

/**
 * A runtime of Prisma's, by where it is: `@prisma/client`'s, which a client generated into `node_modules` requires, or
 * the copy Prisma 6 puts beside a client generated into the project, which requires that one — 3.15's to 6's engines,
 * and the data proxy's. What it exports says it is one.
 */
const RUNTIME = /[\\/]runtime[\\/](?:library|binary|index|edge|data-proxy)\.js$/;

/**
 * The last request at which the module cache is looked at for a client. Until one is found it is looked at in the
 * requests that are powers of two, so an application that declares Prisma and never loads it pays for eleven looks.
 */
export const LAST_LOOK = 1024;

/** An action Prisma names an operation with, `findMany`, and a model a schema declares, `Post`. */
const ACTION = /^[a-z][A-Za-z]*$/;
const MODEL = /^[A-Za-z][A-Za-z0-9_]*$/;
const RAW = new Set(["queryRaw", "executeRaw"]);

interface Proto extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
}

/** What an instance of a generated client has that is read here. */
interface Instance {
  _activeProvider?: unknown;
  _engineConfig?: { adapter?: unknown } | undefined;
}

/** What `_executeRequest` is given, as far as it is read here. */
interface Params {
  action?: unknown;
  model?: unknown;
  args?: unknown;
}

export interface InstrumentPrismaDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at debug,
   * sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /**
   * Where a raw query's SQL becomes a fingerprint, **one cache per dialect**, each read as its own: SQLite's read as
   * MySQL would keep what SQLite reads as a value. A dialect without one counts its raw queries against the dependency.
   */
  fingerprints?: { [Dependency in SqlDependency]?: FingerprintCache | undefined } | undefined;
  /** Where a thrown thing becomes a signature. Absent means errors are counted and not identified. */
  errors?: ErrorFingerprintCache | undefined;
}

/** How many distinct labels one process is expected to name. Beyond this they are made each time. */
const MAX_FINGERPRINTS = 1000;
const fingerprints = new Map<string, Fingerprint>();

/** The operation `findMany Post`, under its dependency. */
function operationFingerprint(dependency: PrismaDependency, action: string, model: unknown): Fingerprint {
  const name = model === undefined ? undefined : typeof model === "string" && MODEL.test(model) ? model : "?";
  const text = name === undefined ? action : `${action} ${name}`;
  const key = `${dependency}\0${text}`;
  const cached = fingerprints.get(key);
  if (cached !== undefined) return cached;
  const fingerprint: Fingerprint = { text, hash: hash64(`prisma\0${key}`) };
  if (fingerprints.size < MAX_FINGERPRINTS) fingerprints.set(key, fingerprint);
  return fingerprint;
}

/**
 * The SQL of a raw query, as the engine is handed it: a tagged template's pieces joined by the database's placeholders,
 * or the text of an `Unsafe` one. Its values are never read.
 */
function rawSql(dependency: SqlDependency, args: unknown): string | undefined {
  if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
  const strings = (args as { strings?: unknown } | null | undefined)?.strings;
  if (!Array.isArray(strings) || !strings.every((piece) => typeof piece === "string")) return undefined;
  return strings.reduce((sql: string, piece: string, i) => {
    if (i === 0) return piece;
    return `${sql}${dependency === "postgres" ? `$${i}` : "?"}${piece}`;
  }, "");
}

/** The operation `_executeRequest` was asked for, or undefined when it has no name a person wrote. */
function fingerprintOf(
  dependency: PrismaDependency,
  params: Params,
  deps: InstrumentPrismaDeps,
): Fingerprint | undefined {
  const { action } = params;
  if (typeof action !== "string" || !ACTION.test(action)) return undefined;
  if (!RAW.has(action) || dependency === "mongodb") return operationFingerprint(dependency, action, params.model);
  const cache = deps.fingerprints?.[dependency];
  const sql = cache === undefined ? undefined : rawSql(dependency, params.args);
  return sql === undefined ? undefined : cache?.get(sql);
}

/** The dependency a client's operations are, or undefined when they are not this observer's to count. */
function dependencyOf(client: Instance): PrismaDependency | undefined {
  const adapter = client._engineConfig?.adapter;
  if (adapter !== undefined && adapter !== null) return undefined;
  const provider = client._activeProvider;
  if (typeof provider !== "string" || !Object.hasOwn(PRISMA_PROVIDERS, provider)) return undefined;
  return PRISMA_PROVIDERS[provider as keyof typeof PRISMA_PROVIDERS];
}

function record(
  ctx: RequestContext,
  dependency: PrismaDependency,
  fingerprint: Fingerprint | undefined,
  started: number,
  failed: boolean,
  err: unknown,
  deps: InstrumentPrismaDeps,
): void {
  // Inside the settling of the operation, before the application's continuation: what is thrown here would be the
  // client's to deal with. Measuring is not worth breaking what is measured (invariant 2).
  try {
    const ended = performance.now();
    recordCallIn(ctx, dependency, "", ended - started, failed);
    if (fingerprint !== undefined) {
      recordOperationIn(ctx, { kind: "query", fingerprint, startedAt: started, endedAt: ended, failed, target: "" });
      recordErrorIn(ctx, deps.errors, failed, err, "", started, ended);
    }
  } catch (failure) {
    deps.internalError(failure);
  }
}

/**
 * Patches the class of a generated client: the `PrismaClient` its module exports. Returns whether there was anything
 * to patch, that is whether it is one. The class is handed over already loaded: the production start-up does not load
 * it (ADR 0209, `armPrisma`), and a test gives one.
 */
export function patchPrisma(client: unknown, version: string, deps: InstrumentPrismaDeps): boolean {
  const proto = typeof client === "function" ? (client.prototype as Proto | undefined) : undefined;
  if (!proto || typeof proto._executeRequest !== "function") return false;
  if (proto[MARK] === true) return true;
  const original = proto._executeRequest as (this: unknown, ...args: unknown[]) => unknown;
  proto._executeRequest = function (this: Instance, ...args: unknown[]): unknown {
    const ctx = currentContext();
    if (!ctx) return original.apply(this, args);
    let dependency: PrismaDependency | undefined;
    let fingerprint: Fingerprint | undefined;
    try {
      dependency = dependencyOf(this);
      if (dependency !== undefined) fingerprint = fingerprintOf(dependency, (args[0] ?? {}) as Params, deps);
    } catch (err) {
      deps.internalError(err);
      return original.apply(this, args);
    }
    if (dependency === undefined) return original.apply(this, args);
    const started = performance.now();
    const result = original.apply(this, args);
    if (result !== null && typeof (result as Promise<unknown>).then === "function") {
      const kind = dependency;
      (result as Promise<unknown>).then(
        () => record(ctx, kind, fingerprint, started, false, undefined, deps),
        (err: unknown) => record(ctx, kind, fingerprint, started, true, err, deps),
      );
    }
    return result;
  };
  proto[MARK] = true;
  deps.log.debug(`instrumented a Prisma client, @prisma/client ${version}`);
  return true;
}

/**
 * Patches the class every generated client in the module cache exports: the modules that required a runtime of
 * Prisma's. Returns how many there were.
 */
function patchCached(cache: NodeJS.Require["cache"], version: string, deps: InstrumentPrismaDeps): number {
  const runtimes = new Set<unknown>();
  for (const [file, module] of Object.entries(cache)) {
    if (module === undefined || !RUNTIME.test(file)) continue;
    const exported = module.exports as { getPrismaClient?: unknown } | null | undefined;
    if (typeof exported?.getPrismaClient === "function") runtimes.add(module);
  }
  if (runtimes.size === 0) return 0;
  let clients = 0;
  for (const module of Object.values(cache)) {
    // What the ES module loader puts in the cache has no `children`: an application's own `.mjs`, for one.
    const children = (module as { children?: unknown } | undefined)?.children;
    if (!Array.isArray(children) || !children.some((child) => runtimes.has(child))) continue;
    try {
      const exported = (module?.exports as { PrismaClient?: unknown } | null | undefined)?.PrismaClient;
      if (patchPrisma(exported, version, deps)) clients += 1;
    } catch (err) {
      deps.internalError(err);
    }
  }
  return clients;
}

const WRAPPED = Symbol.for("downtrace.prisma.runtime");

/** Node's loader, as far as it is wrapped here. */
interface Loader {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
  [WRAPPED]?: boolean;
}

/**
 * Under `check` (ADR 0243): wraps Node's loader so that a runtime of Prisma's, as it is loaded, is handed over with a
 * `getPrismaClient` that patches the class it makes. That reaches a client the module cache never holds — one Vitest
 * runs from the project's own directory, whose runtime is still loaded by Node. What is handed over is every export
 * of the runtime, read from it; the cache holds the same, so a second `require` gets it too.
 */
function wrapRuntimeLoads(version: string, deps: InstrumentPrismaDeps): void {
  const loader = Module as unknown as Loader;
  if (loader[WRAPPED] === true) return;
  loader[WRAPPED] = true;
  const load = loader._load;
  const handed = new WeakSet<object>();
  loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    const loaded = load.call(this, request, parent, isMain);
    // A runtime is what exports `getPrismaClient`: one property read for every other module.
    const getPrismaClient = (loaded as { getPrismaClient?: unknown } | null | undefined)?.getPrismaClient;
    if (typeof getPrismaClient !== "function" || handed.has(loaded as object)) return loaded;
    try {
      const filename = loader._resolveFilename(request, parent, isMain);
      if (!RUNTIME.test(filename)) return loaded;
      const runtime = loaded as Record<string, unknown>;
      const wrapper: Record<string, unknown> = {};
      for (const key of Object.keys(runtime)) {
        if (key !== "getPrismaClient")
          Object.defineProperty(wrapper, key, { get: () => runtime[key], enumerable: true });
      }
      wrapper.getPrismaClient = function (this: unknown, ...args: unknown[]): unknown {
        const client = (getPrismaClient as (...args: unknown[]) => unknown).apply(this, args);
        try {
          patchPrisma(client, version, deps);
        } catch (err) {
          deps.internalError(err);
        }
        return client;
      };
      handed.add(wrapper);
      const cached = createRequire(filename).cache[filename];
      if (cached !== undefined) cached.exports = wrapper;
      return wrapper;
    } catch (err) {
      deps.internalError(err);
      return loaded;
    }
  };
}

/**
 * The start-up half, as the drivers' (ADR 0209): resolve `@prisma/client` from the application's root, load nothing,
 * and patch from the start of a request at which the application has loaded a client. Where that client's runtime is
 * cannot be resolved — a client generated into the project requires a copy of its own, wherever the project put it —
 * so the cache is looked at whole, and so not at every request: at the first, the second, the fourth, up to
 * `LAST_LOOK`, and no more once a client is found. A client loaded after that — a second schema, imported lazily — is
 * not seen.
 */
export function armPrisma(
  deps: InstrumentPrismaDeps & { from?: From | undefined; early?: boolean | undefined },
): Armed {
  // The first base that resolves it: what is patched is found in the module cache whole, wherever the client is, and
  // the resolution only says there is one, and its version.
  let found: { require: NodeRequire; version: string } | undefined;
  for (const base of basesOf(deps.from ?? applicationEntry())) {
    const require = createRequire(base);
    try {
      const read = require("@prisma/client/package.json") as { version?: unknown };
      found = { require, version: typeof read.version === "string" ? read.version : "unknown" };
      break;
    } catch {
      // Not from this base; the next may.
    }
  }
  if (found === undefined) {
    deps.log.debug("@prisma/client is not resolvable from the application's root; not instrumenting Prisma");
    return { state: "unavailable", attach: () => true };
  }
  const { require, version } = found;
  if (deps.early === true) wrapRuntimeLoads(version, deps);
  let requests = 0;
  let next = 1;
  const attach = (): boolean => {
    requests += 1;
    if (requests < next) return false;
    next *= 2;
    if (patchCached(require.cache, version, deps) > 0) return true;
    if (requests < LAST_LOOK) return false;
    deps.log.debug(`no Prisma client was in the module cache by request ${LAST_LOOK}; not instrumenting Prisma`);
    return true;
  };
  return { state: "on", attach };
}
