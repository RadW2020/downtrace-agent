import { execFile } from "node:child_process";
import diagnostics_channel from "node:diagnostics_channel";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, Module } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { attachJest, requiredFrom, type SandboxPatch, wrapJestRuntime } from "../src/jest.ts";
import { testConfig } from "./support/agent-config.ts";

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

/** A loader as Node's `Module.prototype` is one: a `require(id)` called on the module that requires. */
function loaderOf(modules: Record<string, unknown>) {
  const callers: unknown[] = [];
  const loader: { require: (this: unknown, id: string) => unknown } = {
    require(this: unknown, id: string): unknown {
      callers.push(this);
      if (!(id in modules)) throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
      return modules[id];
    },
  };
  return { loader, callers };
}

/** What Jest's own modules are, to a `require` called on them. */
const testWorker = { filename: "/app/node_modules/jest-runner/build/testWorker.js" };

describe("require, watched for jest-runtime where Node announces no load (ADR 0258)", () => {
  // covers: RF-121
  it("wraps the Runtime of the first jest-runtime required, and gives require back", () => {
    const express = { Router: {} };
    const Runtime = runtimeClass({ express });
    const { loader } = loaderOf({ "jest-runtime": { default: Runtime }, "graceful-fs": {} });
    const original = loader.require;
    const patch = recording("express");
    cleanups.push(attachJest({ patches: [patch], internalError, loader }));
    expect(loader.require).not.toBe(original);
    loader.require.call(testWorker, "graceful-fs");
    expect(loader.require).not.toBe(original);
    expect(loader.require.call(testWorker, "jest-runtime")).toEqual({ default: Runtime });
    expect(loader.require).toBe(original);
    new Runtime().requireModule("/app/app.js", "express");
    expect(patch.offered).toEqual([express]);
  });

  // covers: RF-121
  it("calls require on the module that called it, and returns or throws what it did, untouched", () => {
    const lodash = { chunk: () => [] };
    const { loader, callers } = loaderOf({ lodash });
    cleanups.push(attachJest({ patches: [], internalError, loader }));
    expect(loader.require.call(testWorker, "lodash")).toBe(lodash);
    let thrown: unknown;
    try {
      loader.require.call(testWorker, "nonesuch");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "MODULE_NOT_FOUND", message: "Cannot find module 'nonesuch'" });
    expect(callers).toEqual([testWorker, testWorker]);
  });

  // covers: RF-121
  it("goes on watching past a jest-runtime that exports no Runtime", () => {
    const Runtime = runtimeClass({ pg: {} });
    let exported: unknown = { default: class {} };
    const { loader } = loaderOf({});
    const original = loader.require;
    loader.require = function (this: unknown, id: string): unknown {
      return id === "jest-runtime" ? exported : original.call(this, id);
    };
    const own = loader.require;
    cleanups.push(attachJest({ patches: [], internalError, loader }));
    loader.require.call(testWorker, "jest-runtime");
    expect(loader.require).not.toBe(own);
    exported = Runtime;
    loader.require.call(testWorker, "jest-runtime");
    expect(loader.require).toBe(own);
  });

  // covers: RF-121
  it("leaves a require wrapped over its own in place, and is then only a way through", () => {
    const Runtime = runtimeClass({});
    const { loader, callers } = loaderOf({ "jest-runtime": { default: Runtime } });
    cleanups.push(attachJest({ patches: [], internalError, loader }));
    const watched = loader.require;
    // A tracker's hook, installed after the instrumentation's: it calls what it found, which is the watcher.
    const tracker = function (this: unknown, id: string): unknown {
      return watched.call(this, id);
    };
    loader.require = tracker;
    loader.require.call(testWorker, "jest-runtime");
    expect(loader.require).toBe(tracker);
    expect(loader.require.call(testWorker, "jest-runtime")).toEqual({ default: Runtime });
    expect(callers).toHaveLength(2);
  });

  // covers: RF-121
  it("gives require back when the instrumentation stops before Jest loaded its runtime", () => {
    const { loader } = loaderOf({});
    const original = loader.require;
    const stop = attachJest({ patches: [], internalError, loader });
    expect(loader.require).not.toBe(original);
    stop();
    expect(loader.require).toBe(original);
  });

  // covers: RF-121
  it("hands a failure of its own to internalError, and the require still returns what it returned", () => {
    const exported = {
      get default(): unknown {
        throw new Error("a getter that throws");
      },
    };
    const { loader } = loaderOf({ "jest-runtime": exported });
    cleanups.push(attachJest({ patches: [], internalError, loader }));
    expect(loader.require.call(testWorker, "jest-runtime")).toBe(exported);
    expect(handed.splice(0).map((e) => (e as Error).message)).toEqual(["a getter that throws"]);
  });

  it("watches nothing when it is not handed a loader", () => {
    const { loader } = loaderOf({});
    const original = loader.require;
    cleanups.push(attachJest({ patches: [], internalError }));
    expect(loader.require).toBe(original);
  });
});

/**
 * What the agent decides: `require` is watched under `check`, in a project that has Jest, where Node announces no load,
 * and nowhere else. On the real `Module.prototype`, and a `jest-runtime` of the test's.
 */
describe("an agent's start, and the require it watches (ADR 0258)", () => {
  /** A project as `check` names it, with Jest in it or not, and a `jest-runtime` its entry can require. */
  async function project(withJest: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "downtrace-jest-agent-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const runtime = join(dir, "node_modules", "jest-runtime");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "jest-runtime", main: "index.js" }));
    await writeFile(
      join(runtime, "index.js"),
      "class Runtime { requireModule(from, name) { return { name }; } }\nexports.default = Runtime;\n",
    );
    if (withJest) {
      await mkdir(join(dir, "node_modules", "jest"), { recursive: true });
      await writeFile(join(dir, "node_modules", "jest", "package.json"), JSON.stringify({ name: "jest" }));
    }
    await writeFile(join(dir, "entry.js"), "");
    return dir;
  }

  /**
   * An agent started as `check` starts one, or not, on a Node that announces loads or on one that does not: there the
   * start's question on `module.require` goes to a channel Node publishes nothing on, as before Node 22.4.
   */
  const started = (dir: string, { check, announced }: { check: boolean; announced: boolean }): Agent => {
    const config = testConfig("http://127.0.0.1:9", {
      checkRoutes: check ? join(dir, "routes.jsonl") : undefined,
      checkProject: check ? dir : undefined,
    });
    const agent = new Agent(config, { log: { warn: () => {}, debug: () => {} } });
    const channels = diagnostics_channel as { tracingChannel: (name: string) => unknown };
    const tracingChannel = channels.tracingChannel;
    if (!announced)
      channels.tracingChannel = (name) => tracingChannel(name === "module.require" ? "unannounced" : name);
    try {
      agent.start();
    } finally {
      channels.tracingChannel = tracingChannel;
    }
    cleanups.push(() => agent.stop());
    return agent;
  };

  // covers: RF-121
  it("under check, where Node announces no load, in a project that has Jest: until Jest loads its runtime", async () => {
    const dir = await project(true);
    const original = Module.prototype.require;
    started(dir, { check: true, announced: false });
    expect(Module.prototype.require).not.toBe(original);
    const loaded = createRequire(join(dir, "entry.js"))("jest-runtime") as { default: { prototype: object } };
    expect(Module.prototype.require).toBe(original);
    expect(Object.getOwnPropertySymbols(loaded.default.prototype)).toContain(
      Symbol.for("downtrace.jest.requireModule"),
    );
  });

  // covers: RF-121
  it("gives it back when the agent stops first", async () => {
    const dir = await project(true);
    const original = Module.prototype.require;
    const agent = started(dir, { check: true, announced: false });
    expect(Module.prototype.require).not.toBe(original);
    await agent.stop();
    expect(Module.prototype.require).toBe(original);
  });

  // The agent's other base, the entry of the process that runs these tests, resolves this repository's Jest: a project
  // without Jest is `hasJest`'s, below.
  it.each([
    ["where Node announces loads", { check: true, announced: true }],
    ["outside check", { check: false, announced: false }],
  ])("leaves require alone %s", async (_case, how) => {
    const dir = await project(true);
    const original = Module.prototype.require;
    started(dir, how);
    expect(Module.prototype.require).toBe(original);
  });

  // In a child with no `NODE_PATH`: pnpm's shim for Vitest puts its whole store on it, from where Jest always resolves.
  it("finds Jest where the project resolves it, and only there", async () => {
    const withJest = await project(true);
    const without = await project(false);
    const source = new URL("../src/jest.ts", import.meta.url).href;
    const asked = `import { hasJest } from ${JSON.stringify(source)};
console.log(JSON.stringify([hasJest(process.argv[1]), hasJest(process.argv[2]), hasJest([process.argv[2], process.argv[1]])]));`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_PATH"));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", asked, `${withJest}/`, `${without}/`],
      { env },
    );
    expect(JSON.parse(stdout)).toEqual([true, false, true]);
  });
});

/** Node announces loads on `module.require` from 22.4; before it, the watched `require` above stands in for it. */
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
