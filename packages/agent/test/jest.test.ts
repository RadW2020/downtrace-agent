import diagnostics_channel from "node:diagnostics_channel";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachJest, requiredFrom, type SandboxPatch, wrapJestRuntime } from "../src/jest.ts";

/**
 * The bridge to Jest's own module registry, on a `Runtime` of the test's: what it offers to which patch, what it
 * returns, and what it does when a patch fails. Real Jest, 29 and 30, is `check.test.ts`'s.
 */

const handed: unknown[] = [];
const internalError = (err: unknown): void => {
  handed.push(err);
};
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  expect(handed.splice(0), "the bridge failed").toEqual([]);
  while (cleanups.length) await cleanups.pop()?.();
});

/** A `Runtime` as `jest-runtime` exports it: a class whose `requireModule(from, name)` returns the module. */
function runtimeClass(modules: Record<string, unknown>) {
  return class Runtime {
    requireModule(_from: string, name: string): unknown {
      return modules[name];
    }
  };
}

/** A patch that writes down what it was offered. */
function recording(name: string): SandboxPatch & { offered: unknown[] } {
  const offered: unknown[] = [];
  return { offered, matches: (asked) => asked === name, patch: (exports) => offered.push(exports) };
}

describe("Jest's requireModule, wrapped", () => {
  it("offers each module a sandbox requires to the patch that knows it, and returns what Jest returned", () => {
    const pg = { Client: class {} };
    const Runtime = runtimeClass({ pg, lodash: { chunk: () => [] } });
    const patch = recording("pg");
    expect(wrapJestRuntime({ default: Runtime }, { patches: [patch], internalError })).toBe(true);
    const runtime = new Runtime();
    expect(runtime.requireModule("/app/src/db.js", "pg")).toBe(pg);
    expect(runtime.requireModule("/app/src/util.js", "lodash")).toEqual({ chunk: expect.any(Function) });
    expect(patch.offered).toEqual([pg]);
  });

  it("is wrapped once however many times it is asked", () => {
    const Runtime = runtimeClass({ pg: {} });
    const patch = recording("pg");
    wrapJestRuntime(Runtime, { patches: [patch], internalError });
    wrapJestRuntime(Runtime, { patches: [patch], internalError });
    new Runtime().requireModule("/app/a.js", "pg");
    expect(patch.offered).toHaveLength(1);
  });

  it("hands a patch that throws to internalError, and the test still gets its module", () => {
    const pg = {};
    const Runtime = runtimeClass({ pg });
    const failing: SandboxPatch = {
      matches: () => true,
      patch: () => {
        throw new Error("boom");
      },
    };
    wrapJestRuntime(Runtime, { patches: [failing], internalError });
    expect(new Runtime().requireModule("/app/a.js", "pg")).toBe(pg);
    expect(handed.splice(0).map((e) => (e as Error).message)).toEqual(["boom"]);
  });

  it("refuses what is not a Runtime", () => {
    expect(wrapJestRuntime(undefined, { patches: [], internalError })).toBe(false);
    expect(wrapJestRuntime({ default: class {} }, { patches: [], internalError })).toBe(false);
  });

  it("says where a module was required from, whatever the separator", () => {
    expect(requiredFrom("/app/node_modules/postgres/cjs/src/index.js", "postgres", "cjs", "src", "index.js")).toBe(
      true,
    );
    expect(requiredFrom("C:\\app\\node_modules\\mysql2\\promise.js", "mysql2", "promise.js")).toBe(true);
    expect(requiredFrom("/app/node_modules/not-mysql2/promise.js", "mysql2", "promise.js")).toBe(false);
  });
});

/** Node 20 has no `module.require` channel, and there the bridge stays unattached, as the README says. */
const announces = await (async () => {
  let seen = false;
  const channel = diagnostics_channel.tracingChannel("module.require");
  const handlers = {
    start: () => {},
    end: () => {
      seen = true;
    },
    asyncStart: () => {},
    asyncEnd: () => {},
    error: () => {},
  };
  channel.subscribe(handlers);
  createRequire(import.meta.url)("node:os");
  channel.unsubscribe(handlers);
  return seen;
})();

describe.skipIf(!announces)("the bridge, as Node announces jest-runtime", () => {
  it("wraps the Runtime of the jest-runtime a process loads, and stops when asked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "downtrace-jest-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const runtime = join(dir, "node_modules", "jest-runtime");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "jest-runtime", main: "index.js" }));
    await writeFile(
      join(runtime, "index.js"),
      "class Runtime { requireModule(from, name) { return { name }; } }\nexports.default = Runtime;\n",
    );
    await writeFile(join(dir, "entry.js"), "");
    const patch = recording("express");
    const stop = attachJest({ patches: [patch], internalError });
    cleanups.push(stop);
    const loaded = createRequire(join(dir, "entry.js"))("jest-runtime") as {
      default: new () => { requireModule(from: string, name: string): unknown };
    };
    new loaded.default().requireModule(join(dir, "app.js"), "express");
    expect(patch.offered).toEqual([{ name: "express" }]);
  });
});
