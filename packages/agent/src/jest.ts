import diagnostics_channel from "node:diagnostics_channel";

/**
 * Jest runs a test file's modules in a registry of its own: `jest-runtime` reads, compiles and caches every module the
 * tests require, `pg` and `express` among them, and none of them enters Node's `require.cache`. The drivers this
 * instrumentation patches from that cache (ADR 0209) and the Express it arms at start-up are, under Jest, copies the
 * application never uses, and a suite run by Jest — the runner most Node backends are tested with — was, for
 * `downtrace check`, routes named by the shape of their paths and no query at all (the stranger campaign of
 * 2026-10-29: an Express and `pg` application, 0 queries seen; a Mongoose boilerplate, `/:param/:param/login` for
 * `/v1/auth/login`). What reaches Node's own modules — the diagnostics channels of `http`, Fastify, the Redis
 * clients, `undici` — is unaffected: Jest hands a test the process's built-ins.
 *
 * So, when `jest-runtime` itself is loaded — by Node's `require`, which Node announces on its `module.require`
 * tracing channel — its `requireModule`, the one every `require` of a test file goes through, is wrapped: each
 * module a sandbox requires is offered to the patches that know it, which patch the copy the tests use. The
 * channel is observed, the loading is not changed (no load hook, ADR 0209), and the wrapper returns what Jest
 * returned. Node 20 has no `module.require` channel, and there a suite run by Jest stays as it was.
 */

/** A module a sandbox may require, and what to do to the copy it gets. */
export interface SandboxPatch {
  /** Whether this is the module: by the name it was required with, and the file that required it. */
  matches(name: string, from: string): boolean;
  /** Patches the sandbox's copy. Idempotent: a module is offered on every `require` of it. */
  patch(exports: unknown): void;
}

export interface JestDeps {
  patches: readonly SandboxPatch[];
  /** Where a failure of this file's own code goes (invariant 2, ADR 0161). Never to the test that required. */
  internalError: (err: unknown) => void;
}

const MARK = Symbol.for("downtrace.jest.requireModule");

interface RuntimePrototype extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
}

interface RequireMessage {
  id?: unknown;
  result?: unknown;
}

/**
 * Wraps `requireModule` of the `Runtime` class `jest-runtime` exports. Returns whether there was one to wrap.
 * Exported for the tests, which hand it a class of their own.
 */
export function wrapJestRuntime(exported: unknown, deps: JestDeps): boolean {
  const runtime = (exported as { default?: unknown } | null | undefined)?.default ?? exported;
  const proto = (runtime as { prototype?: RuntimePrototype } | null | undefined)?.prototype;
  if (!proto || typeof proto.requireModule !== "function") return false;
  if (proto[MARK] === true) return true;
  const original = proto.requireModule as (this: unknown, ...args: unknown[]) => unknown;
  proto.requireModule = function (this: unknown, ...args: unknown[]): unknown {
    const exports = original.apply(this, args);
    try {
      const [from, name] = args;
      if (typeof name === "string") {
        const file = typeof from === "string" ? from : "";
        for (const patch of deps.patches) if (patch.matches(name, file)) patch.patch(exports);
      }
    } catch (err) {
      deps.internalError(err);
    }
    return exports;
  };
  proto[MARK] = true;
  return true;
}

/**
 * Listens for `jest-runtime` being loaded, from the start: a process that never runs Jest pays one comparison per
 * module it loads, at load, and nothing in a request. Returns what stops listening.
 */
export function attachJest(deps: JestDeps): () => void {
  const channel = diagnostics_channel.tracingChannel("module.require");
  const handlers = {
    start: () => {},
    end: (message: unknown) => {
      try {
        const { id, result } = message as RequireMessage;
        if (id === "jest-runtime") wrapJestRuntime(result, deps);
      } catch (err) {
        deps.internalError(err);
      }
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

/** The file a module was required from ends with this path, whatever the separator. */
export function requiredFrom(from: string, ...segments: string[]): boolean {
  return from.replaceAll("\\", "/").endsWith(`/${segments.join("/")}`);
}
