import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { recordCall } from "../context.ts";
import type { Logger } from "../log.ts";

const MARK = Symbol.for("downtrace.pg.instrumented");

/** Shape of the part of `pg` we touch. Anything else about the module is none of our business. */
interface PgProto extends Record<string, unknown> {
  [MARK]?: boolean;
}

interface PgModule {
  Client?: { prototype?: PgProto };
}

export interface InstrumentPgDeps {
  log: Logger;
  /** Resolution base; defaults to the application's entry point, then its working directory. */
  from?: string | undefined;
  /** Injected in tests instead of resolving the real module. */
  moduleImpl?: unknown;
}

/**
 * Wraps `pg`'s `Client.prototype.query` so every query counts towards the request that issued it.
 *
 * The agent loads before the application (`node --import`), resolves `pg` from the application's own root and
 * patches the prototype. CommonJS modules are cached by resolved path, so the instance the application later
 * imports is the one patched here: no loader hooks, no dependency, and it works whether the app is ESM or CJS.
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
      const base = deps.from ?? process.argv[1] ?? `${process.cwd()}/`;
      const require = createRequire(base);
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

  const original = proto.query as (...args: unknown[]) => unknown;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    // Everything below is best effort: a bug here must never change what the application's query does.
    let done: ((failed?: boolean) => void) | undefined;
    try {
      const started = performance.now();
      let counted = false;
      done = (failed = false) => {
        if (counted) return;
        counted = true;
        recordCall("postgres", "", performance.now() - started, failed);
      };
      const last = args.at(-1);
      if (typeof last === "function") {
        // Callback form: count when the callback fires, then hand control to the application's own callback.
        const callback = last as (...cbArgs: unknown[]) => unknown;
        const finish = done;
        args[args.length - 1] = function (this: unknown, ...cbArgs: unknown[]): unknown {
          finish(cbArgs[0] != null); // pg's callback convention: a non-null first argument is the error
          return callback.apply(this, cbArgs);
        };
        return original.apply(this, args);
      }
    } catch {
      return original.apply(this, args); // instrumentation failed before doing anything: run the query untouched
    }

    const result = original.apply(this, args);
    // Promise form. A Cursor or a QueryStream is not thenable and passes through unmeasured, by design.
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      const settle = done;
      return (result as Promise<unknown>).then(
        (value) => {
          settle?.();
          return value;
        },
        (err: unknown) => {
          settle?.(true);
          throw err; // the application sees exactly the error it would have seen
        },
      );
    }
    done?.();
    return result;
  };

  proto.query = wrapped;
  proto[MARK] = true;
  deps.log.debug(`instrumented pg ${version}`);
  return version;
}
