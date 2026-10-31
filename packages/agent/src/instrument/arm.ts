import diagnostics_channel from "node:diagnostics_channel";
import { createRequire } from "node:module";
import path, { dirname, join } from "node:path";
import { basesOf, type From } from "../entry.ts";
import type { Logger } from "../log.ts";

/**
 * What a driver's observer leaves behind at start-up: what the batch can already report, and the attach that runs
 * the patch from the start of a request.
 */
export interface Armed {
  /**
   * Resolved from the application's root and from the packages that bring a copy of their own: «on» when there is
   * a driver to instrument, or «unavailable» when there is none.
   */
  state: "on" | "unavailable";
  /**
   * Patches the driver once the application has loaded it. Called from the start of each request until it
   * settles: `true` when the attach is done — every copy patched, or decided there is nothing to patch in it — and
   * `false` while the application has not loaded one of them yet.
   */
  attach: () => boolean;
  /**
   * The same patch, asked in the microtask after the application loads modules (`whenLoaded`, ADR 0246), and so in the
   * request that loads the driver, before its handler goes on to query. It does only what the module cache can say at
   * that moment: an observer whose attach starts an import, or looks at the whole cache, leaves that to the request.
   * Unsaid where there is nothing of the kind to do.
   */
  atLoad?: (() => boolean) | undefined;
}

export interface ArmDeps<Driver> {
  /** The package the application is asked for, by the name it requires it with: `pg`, `mysql2`. */
  driver: string;
  /**
   * Resolution base: the application's entry as Node runs it, resolved once by the start (DT-34), and under `check`
   * the project's directory beside it (`resolutionBases`). Every copy found from either is armed.
   */
  from: From;
  /**
   * Packages that bring a copy of the driver of their own, by the name the application requires them with. The copy
   * such a package loads is the one its queries go through, and it is not always the application's: a package
   * manager that keeps what the application did not declare out of its root has no driver there at all, and one
   * that cannot satisfy both ranges with a single copy nests another inside the package. Each copy that is a module
   * of its own is armed beside the application's, from where that package resolves it (DT-92).
   */
  beside?: readonly string[] | undefined;
  /**
   * The module of the driver whose presence in the module cache says the application loaded it, by its path from the
   * directory of the driver's entry; the entry itself when unsaid. `mysql2/promise` loads the driver's classes and
   * not its entry. It is that module `patch` is given, and the entry is not loaded for it.
   */
  trigger?: string | undefined;
  log: Logger;
  /**
   * Where a failure of the attach goes: the agent's count of internal errors (invariant 2, ADR 0161). Never
   * handed to the request that asked for the attach.
   */
  internalError: (err: unknown) => void;
  /**
   * Patches the module the application loaded, whose version the package says. The shape of the module is
   * checked here, by the observer that knows how to say it is wrong. The `require` that found the copy, and the file
   * it resolved, are for a patch whose class is in a module of the driver's other than its entry.
   */
  patch: (module: Driver, version: string, require: NodeRequire, resolved: string) => void;
}

/**
 * The start-up half of a driver's instrumentation: it resolves the driver from the application's root and does
 * not load it (ADR 0209).
 *
 * Loading it here would warm the module cache before the application's own load, and a tracker that
 * instruments the driver by hooking module loading would then never see it the way it would alone: with this
 * observer loaded first, its hook for the driver's pool would never run at all (the application loads the driver
 * once, from the cache this observer warmed); with the tracker loaded first, its hook would run a second time on
 * top of this observer's wrapper, which it does not recognise as one, and would wrap the query twice.
 * Resolving keeps the patch where it has to be — on the prototype the application actually uses, whatever order
 * the two are loaded in — without taking the load from the application.
 *
 * The patch itself runs in `attach`, from the start of the first request at which the driver is in the module
 * cache: by then the application has loaded it (a server that answers a request has finished its start-up), and the
 * wrapper is in place before the request's handler runs. What that moment gives up — a query the application makes
 * in the very request that loads the driver, a lazy import in a handler — the same attach takes back from Node 22, in
 * the microtask after the application loads the driver (`whenLoaded`, ADR 0246).
 *
 * The second driver to be observed (DT-91) is why this is a function of its own: the mechanism is ADR 0209's
 * and it is the same for every driver, so a correction to it is one correction.
 */
export function armDriver<Driver>(deps: ArmDeps<Driver>): Armed {
  const { driver, log } = deps;
  const copies: Copy[] = [];
  const keep = (copy: Copy): void => {
    // The same module found by two ways is one patch and one count, and a layout that hoists them is that.
    if (!copies.some((other) => other.resolved === copy.resolved)) copies.push(copy);
  };
  const bases = basesOf(deps.from);
  for (const base of bases) {
    const own = copyOf(base, driver, log);
    if (own) keep(own);
  }
  if (copies.length === 0) log.debug(`${driver} is not resolvable from the application's root; not instrumenting`);
  for (const name of deps.beside ?? []) {
    for (const base of bases) {
      let from: string;
      try {
        from = createRequire(base).resolve(name);
      } catch {
        continue; // most applications do not have it, and that is not worth a line
      }
      const copy = copyOf(from, driver, log);
      if (copy) keep(copy);
      else log.debug(`${name} is installed and its ${driver} is not resolvable from it; not instrumenting that copy`);
    }
  }
  if (copies.length === 0) return { state: "unavailable", attach: () => true };

  const attach = (): boolean => {
    for (let i = 0; i < copies.length; ) {
      const copy = copies[i] as Copy;
      const loaded = deps.trigger === undefined ? copy.resolved : join(dirname(copy.resolved), deps.trigger);
      // Until the application loads the driver there is nothing to patch, and nothing is lost by waiting:
      // a query cannot run before the driver is loaded, and a query outside a request is not counted
      // (`context.ts`). The check is two property reads on the module cache, once per request until then. Loaded,
      // and not only there: the ES module loader puts a CommonJS module it imports in the cache as it links the
      // graph, and runs it later, so an entry can be there and export nothing yet (ADR 0246).
      const cached = copy.require.cache[loaded];
      if (cached?.loaded !== true) {
        i += 1;
        continue;
      }
      copies.splice(i, 1);
      try {
        // Off the cache, and not through `require`: an application that imports the driver from an ES module loads it
        // without `Module.prototype.require`, where a tracker's hook for CommonJS sits, and a `require` here would be
        // the first that hook sees. The tracker would patch the driver there, and again at its hook for ES modules,
        // on top of this observer's wrapper: every span twice (ADR 0246).
        deps.patch(cached.exports as Driver, copy.version, copy.require, copy.resolved);
      } catch (err) {
        // A failure of the attach is a failure of the instrumentation's own: counted like any other
        // (invariant 2, ADR 0161), and never handed to the request that asked for it. The copy leaves the list
        // either way, and the other copies are attached as if it had not failed.
        deps.internalError(err);
      }
    }
    return copies.length === 0;
  };
  // The copies are one list, so a copy patched at a load is not patched again at a request, nor the reverse.
  return { state: "on", attach, atLoad: attach };
}

/**
 * Several armed observers as one: «on» when any is, and settled when every one is. Each is asked at every attach
 * until then: one settled is no reason to stop asking the others.
 */
export function armedTogether(armed: readonly Armed[]): Armed {
  return {
    state: armed.some((one) => one.state === "on") ? "on" : "unavailable",
    attach: () => armed.map((one) => one.attach()).every(Boolean),
    atLoad: () => armed.map((one) => one.atLoad?.() ?? true).every(Boolean),
  };
}

/**
 * Runs `attach` each time the process has loaded modules through `require` — an `import` of a CommonJS module too —,
 * which Node announces on its `module.require` channel from 22 (ADR 0246): once the code that loaded them has run to
 * its end, in a microtask, and so before anything that code waits for. A lazy import in a handler is patched before the
 * handler's first query, which waits for a connection, or for the import itself.
 *
 * Not at the end of the load. A driver loads its classes one module at a time, and `mysql2`'s connection has finished
 * loading before its pool starts. And a tracker's hook on `require` patches the driver as that `require` returns, after
 * the end Node announces: its hook recognises its own wrapper, and unwraps it before it wraps again, and a wrapper of
 * ours in between would hide it — every span twice, which ADR 0209 is there to prevent. In the microtask the driver is
 * whole, and the tracker's wrapper is under ours, as it is when the first request patches it.
 *
 * Until `attach` settles, or the returned function is called. Node 20 announces nothing, and there the first request
 * after the load is the moment, as ADR 0209 says. What the attach requires does not ask it again, and what it throws
 * goes to `internalError`.
 */
export function whenLoaded(deps: { attach: () => boolean; internalError: (err: unknown) => void }): () => void {
  const channel = diagnostics_channel.tracingChannel("module.require");
  // One microtask for a run of loads: a start-up loads thousands of modules in one turn.
  let queued = false;
  let attaching = false;
  let stopped = false;
  const attach = (): void => {
    queued = false;
    if (stopped) return;
    attaching = true;
    try {
      if (deps.attach()) stop();
    } catch (err) {
      deps.internalError(err);
    } finally {
      attaching = false;
    }
  };
  const handlers = {
    start: () => {},
    end: () => {
      if (queued || attaching) return;
      queued = true;
      queueMicrotask(attach);
    },
    asyncStart: () => {},
    asyncEnd: () => {},
    error: () => {},
  };
  const stop = (): void => {
    stopped = true;
    channel.unsubscribe(handlers);
  };
  channel.subscribe(handlers);
  return stop;
}

/**
 * Patches a package as the application requires it by its name — which Node announces on its `module.require` channel,
 * from Node 22 — and at once a copy the application has loaded already, resolved from `from`. For what has to be
 * patched before the application uses it at start-up, which the first request is too late for: a pool that binds a
 * method of its class as it is built, an adapter connected in a NestJS module's `onModuleInit`. Nothing is loaded here:
 * the patch runs on what the application loaded. `accept` is asked with the file the name resolves to, from where it
 * was required. Returns what stops listening.
 */
export function whenRequired(deps: {
  name: string;
  from: From;
  accept?: ((file: string) => boolean) | undefined;
  patch: (exports: unknown) => void;
  internalError: (err: unknown) => void;
}): () => void {
  const { name, accept, patch, internalError } = deps;
  const patchCopy = (exports: unknown): void => {
    try {
      patch(exports);
    } catch (err) {
      internalError(err);
    }
  };
  for (const base of basesOf(deps.from)) {
    let file: string;
    try {
      file = createRequire(base).resolve(name);
    } catch {
      continue; // most applications do not have it
    }
    const loaded = createRequire(base).cache[file];
    if (loaded !== undefined && (accept?.(file) ?? true)) patchCopy(loaded.exports);
  }
  const channel = diagnostics_channel.tracingChannel("module.require");
  const handlers = {
    start: () => {},
    end: (message: unknown) => {
      const { id, parentFilename, result } = message as { id?: unknown; parentFilename?: unknown; result?: unknown };
      // One comparison for every module the process loads, at load, and nothing in a request.
      if (id !== name || typeof parentFilename !== "string" || !path.isAbsolute(parentFilename)) return;
      if (accept !== undefined) {
        let file: string;
        try {
          file = createRequire(parentFilename).resolve(name);
        } catch {
          return;
        }
        if (!accept(file)) return;
      }
      patchCopy(result);
    },
    asyncStart: () => {},
    asyncEnd: () => {},
    error: () => {},
  };
  channel.subscribe(handlers);
  return () => {
    channel.unsubscribe(handlers);
  };
}

/** One copy of the driver: where it is, what version it says it is, and the `require` that finds it. */
interface Copy {
  resolved: string;
  version: string;
  require: NodeRequire;
}

/** The copy of the driver that resolves from `from`, or nothing. Resolves, and loads nothing. */
function copyOf(from: string, driver: string, log: Logger): Copy | undefined {
  const require = createRequire(from);
  let resolved: string;
  try {
    resolved = require.resolve(driver);
  } catch {
    return undefined;
  }
  // The version of the log, read at start-up where the old start-up require read it, and not in a request.
  let version = "unknown";
  try {
    const pkg = require(`${driver}/package.json`) as { version?: unknown };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    log.debug(`${driver} resolved but its version could not be read; it stays unknown`);
  }
  return { resolved, version, require };
}
