import { createRequire } from "node:module";
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
}

export interface ArmDeps<Driver> {
  /** The package the application is asked for, by the name it requires it with: `pg`, `mysql2`. */
  driver: string;
  /** Resolution base: the application's entry as Node runs it, resolved once by the start (DT-34). */
  from: string;
  /**
   * Packages that bring a copy of the driver of their own, by the name the application requires them with. The copy
   * such a package loads is the one its queries go through, and it is not always the application's: a package
   * manager that keeps what the application did not declare out of its root has no driver there at all, and one
   * that cannot satisfy both ranges with a single copy nests another inside the package. Each copy that is a module
   * of its own is armed beside the application's, from where that package resolves it (DT-92).
   */
  beside?: readonly string[] | undefined;
  log: Logger;
  /**
   * Where a failure of the attach goes: the agent's count of internal errors (invariant 2, ADR 0161). Never
   * handed to the request that asked for the attach.
   */
  internalError: (err: unknown) => void;
  /**
   * Patches the module the application loaded, whose version the package says. The shape of the module is
   * checked here, by the observer that knows how to say it is wrong.
   */
  patch: (module: Driver, version: string) => void;
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
 * cache: by then the application has loaded it (a server that answers a request has finished its start-up), the
 * `require` is a cache hit that re-executes nothing, and the wrapper is in place before the request's handler
 * runs. What that moment gives up is said in ADR 0209: a query the application makes in the very request that
 * loads the driver for the first time — a lazy import in a handler — is the one this observer does not count;
 * from the next request it counts again.
 *
 * The second driver to be observed (DT-91) is why this is a function of its own: the mechanism is ADR 0209's
 * and it is the same for every driver, so a correction to it is one correction.
 */
export function armDriver<Driver>(deps: ArmDeps<Driver>): Armed {
  const { driver, log } = deps;
  const copies: Copy[] = [];
  const own = copyOf(deps.from, driver, log);
  if (own) {
    copies.push(own);
  } else {
    log.debug(`${driver} is not resolvable from the application's root; not instrumenting`);
  }
  for (const name of deps.beside ?? []) {
    let from: string;
    try {
      from = createRequire(deps.from).resolve(name);
    } catch {
      continue; // most applications do not have it, and that is not worth a line
    }
    const copy = copyOf(from, driver, log);
    if (!copy) {
      log.debug(`${name} is installed and its ${driver} is not resolvable from it; not instrumenting that copy`);
    } else if (!copies.some((other) => other.resolved === copy.resolved)) {
      // The same module found by two ways is one patch and one count, and a layout that hoists them is that.
      copies.push(copy);
    }
  }
  if (copies.length === 0) return { state: "unavailable", attach: () => true };

  const attach = (): boolean => {
    for (let i = 0; i < copies.length; ) {
      const copy = copies[i] as Copy;
      // Until the application loads the driver there is nothing to patch, and nothing is lost by waiting:
      // a query cannot run before the driver is loaded, and a query outside a request is not counted
      // (`context.ts`). The check is one property read on the module cache, once per request until then.
      if (copy.require.cache[copy.resolved] === undefined) {
        i += 1;
        continue;
      }
      copies.splice(i, 1);
      try {
        deps.patch(copy.require(driver) as Driver, copy.version);
      } catch (err) {
        // A failure of the attach is a failure of the instrumentation's own: counted like any other
        // (invariant 2, ADR 0161), and never handed to the request that asked for it. The copy leaves the list
        // either way, and the other copies are attached as if it had not failed.
        deps.internalError(err);
      }
    }
    return copies.length === 0;
  };
  return { state: "on", attach };
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
