import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { armDriver, whenLoaded } from "../src/instrument/arm.ts";

/**
 * The moment a driver is patched at, when the application loads it inside a request: the end of the outermost load
 * Node announces on its `module.require` channel (ADR 0246). Each test lays out a package of its own in a directory
 * of its own, so that every `require` of it is a first load, and loads it from this process: the channel is the
 * process's, and so is the module cache the attach reads.
 */

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** A driver laid out as `mysql2` is: an entry that loads its connection, and then its pool, each a module of its own. */
async function driver(): Promise<{
  dir: string;
  require: NodeRequire;
  entry: string;
  connection: string;
  pool: string;
}> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "downtrace-when-loaded-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "node_modules", "drv");
  await mkdir(path.join(root, "lib"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "drv", version: "1.0.0" }), "utf8");
  await writeFile(
    path.join(root, "index.js"),
    'exports.Connection = require("./lib/connection.js");\nexports.Pool = require("./lib/pool.js");\n',
    "utf8",
  );
  await writeFile(path.join(root, "lib", "connection.js"), "module.exports = class Connection {};\n", "utf8");
  await writeFile(path.join(root, "lib", "pool.js"), "module.exports = class Pool {};\n", "utf8");
  await writeFile(path.join(dir, "other.js"), "module.exports = 1;\n", "utf8");
  return {
    dir,
    require: createRequire(path.join(dir, "app.js")),
    entry: path.join(root, "index.js"),
    connection: path.join(root, "lib", "connection.js"),
    pool: path.join(root, "lib", "pool.js"),
  };
}

function listen(attach: () => boolean, internalError: (err: unknown) => void = (err) => expect.fail(String(err))) {
  const stop = whenLoaded({ attach, internalError });
  cleanups.push(stop);
  return stop;
}

describe("whenLoaded", () => {
  it("attaches once the load is over, with every module of it loaded, before what the code that loaded it waits for", async () => {
    const drv = await driver();
    // What the attach saw of the driver each time it found any of it in the cache.
    const seen: Array<[connection: boolean, pool: boolean, entry: boolean]> = [];
    listen(() => {
      const loaded = (file: string) => drv.require.cache[file]?.loaded === true;
      if (drv.require.cache[drv.connection] === undefined) return false;
      seen.push([loaded(drv.connection), loaded(drv.pool), loaded(drv.entry)]);
      return true;
    });

    drv.require("drv");
    // Not yet: a tracker's hook on `require` patches what it loaded as that `require` returns.
    expect(seen).toEqual([]);
    await Promise.resolve();
    // The connection finishes loading before the pool starts: an attach at its end would have had to load the pool.
    expect(seen).toEqual([[true, true, true]]);
  });

  it("attaches after a tracker's hook on `require` has patched what the application loaded", async () => {
    // A tracker's hook that recognises its own wrapper unwraps it before it wraps again, and one of ours in between
    // would hide it: every span twice (ADR 0209). So ours goes on last, on top of the tracker's.
    const drv = await driver();
    const order: string[] = [];
    const proto = Module.prototype as unknown as { require: (id: string) => unknown };
    const original = proto.require;
    proto.require = function (this: unknown, id: string) {
      const exports = original.call(this, id);
      if (id === "drv") order.push("tracker");
      return exports;
    };
    cleanups.push(() => {
      proto.require = original;
    });
    listen(() => {
      if (drv.require.cache[drv.entry]?.loaded !== true) return false;
      order.push("attach");
      return true;
    });

    drv.require("drv");
    await Promise.resolve();
    expect(order).toEqual(["tracker", "attach"]);
  });

  it("asks once for each run of loads until the attach settles, and not after", async () => {
    const drv = await driver();
    let asked = 0;
    listen(() => {
      asked += 1;
      return drv.require.cache[drv.entry] !== undefined;
    });

    drv.require("./other.js");
    await Promise.resolve();
    expect(asked).toBe(1);
    drv.require("drv");
    await Promise.resolve();
    expect(asked).toBe(2);
    delete drv.require.cache[path.join(drv.dir, "other.js")];
    drv.require("./other.js");
    await Promise.resolve();
    expect(asked).toBe(2);
  });

  it("is not asked again by what the attach itself requires", async () => {
    const drv = await driver();
    let asked = 0;
    listen(() => {
      asked += 1;
      if (drv.require.cache[drv.entry] === undefined) return false;
      // A cache hit, and a first load: the patch of a driver whose class is in a module of its own does both.
      drv.require("drv");
      drv.require("./other.js");
      return false;
    });

    drv.require("drv");
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked).toBe(1);
  });

  it("hands a failure of the attach to internalError, and the application's require goes on", async () => {
    const drv = await driver();
    const handed: unknown[] = [];
    listen(
      () => {
        throw new Error("attach");
      },
      (err) => handed.push(err),
    );

    const module = drv.require("drv") as { Connection?: unknown };
    expect(typeof module.Connection).toBe("function");
    await Promise.resolve();
    expect(handed.map((err) => (err as Error).message)).toEqual(["attach"]);
  });

  it("stops listening when asked to", async () => {
    const drv = await driver();
    let asked = 0;
    const stop = listen(() => {
      asked += 1;
      return false;
    });

    stop();
    drv.require("drv");
    await Promise.resolve();
    expect(asked).toBe(0);
  });
});

describe("armDriver's attach", () => {
  it("takes the driver from the module cache, and not through a `require` a tracker's load hook would take for the application's", async () => {
    // An application that imports the driver from an ES module loads it without `Module.prototype.require`, which is
    // where a tracker's hook for CommonJS sits; a `require` of it from the attach would be the first that hook sees,
    // and the tracker would patch it there and again at its hook for ES modules, on top of this observer's wrapper:
    // every span twice (ADR 0209, measured again with ADR 0246).
    const drv = await driver();
    const loaded = drv.require("drv") as { Connection: unknown };
    const proto = Module.prototype as unknown as { require: (id: string) => unknown };
    const original = proto.require;
    const seen: string[] = [];
    proto.require = function (this: unknown, id: string) {
      seen.push(id);
      return original.call(this, id);
    };
    cleanups.push(() => {
      proto.require = original;
    });
    const patched: unknown[] = [];
    const armed = armDriver<{ Connection: unknown }>({
      driver: "drv",
      from: path.join(drv.dir, "app.js"),
      log: { warn: () => {}, debug: () => {} },
      internalError: (err) => expect.fail(String(err)),
      patch: (module) => {
        patched.push(module.Connection);
      },
    });

    expect(armed.atLoad?.()).toBe(true);
    proto.require = original;
    expect(patched).toEqual([loaded.Connection]);
    expect(seen.filter((id) => id === "drv" || id.endsWith(path.join("drv", "index.js")))).toEqual([]);
  });
});

describe("a driver an ES module imports", () => {
  it("is patched once it has run, and not when the loader has only read it", async () => {
    // The ES module loader puts a CommonJS module it imports in the module cache as it links the graph, to read what
    // it exports, and runs it later, in the graph's order: until then the entry is there, unloaded, and exports
    // nothing. A module of the graph that runs before the driver ends a load of its own, and an attach then would
    // find the driver's classes missing, and give up on it.
    const drv = await driver();
    const arm = fileURLToPath(new URL("../src/instrument/arm.ts", import.meta.url));
    await writeFile(path.join(drv.dir, "first.cjs"), "module.exports = 1;\n", "utf8");
    await writeFile(path.join(drv.dir, "graph.mjs"), 'import "./first.cjs";\nimport drv from "drv";\n', "utf8");
    await writeFile(
      path.join(drv.dir, "main.mjs"),
      `
      import { armDriver, whenLoaded } from ${JSON.stringify(arm)};
      const patched = [];
      const internalError = (err) => console.log("internal", String(err));
      const armed = armDriver({
        driver: "drv", from: ${JSON.stringify(path.join(drv.dir, "app.js"))},
        log: { warn: () => {}, debug: (line) => console.log("debug", line) }, internalError,
        patch: (module) => patched.push(typeof module.Connection),
      });
      whenLoaded({ attach: () => armed.atLoad(), internalError });
      await import("./graph.mjs");
      console.log(JSON.stringify(patched));
      `,
      "utf8",
    );
    const child = spawn(process.execPath, [path.join(drv.dir, "main.mjs")], { env: { ...process.env, NODE_PATH: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code, stderr).toBe(0);
    expect(stdout.trim().split("\n")).toEqual(['["function"]']);
  });
});
