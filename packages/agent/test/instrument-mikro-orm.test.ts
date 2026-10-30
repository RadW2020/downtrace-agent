import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Armed } from "../src/instrument/arm.ts";
import { armMongo } from "../src/instrument/mongodb.ts";
import { armMysql } from "../src/instrument/mysql.ts";
import { armPg } from "../src/instrument/pg.ts";
import { armSqlite } from "../src/instrument/sqlite.ts";
import type { Logger } from "../src/log.ts";

/**
 * The driver MikroORM brings. Each of its packages for a database has that database's driver as a dependency of its
 * own, pinned to one version — `@mikro-orm/postgresql` 7.2.5 brings `pg` 8.23.1 —, and the application installs only
 * the MikroORM package. With pnpm, whose `node_modules` holds only what the application declares, the driver sits
 * beside the MikroORM package in the store and nothing resolves it from the application's root; with npm, a driver of
 * the application's at another version than the pin leaves MikroORM's nested inside the package. Either way the copy
 * the queries go through is not the application's, as with Prisma's adapter and Mongoose (DT-92).
 *
 * The drivers are the real ones, linked into the store as pnpm links them, so that what is patched is a driver and
 * not a stand-in; the MikroORM packages are their `package.json` and an entry, as published: version 7 an ES module
 * with one export, 6 with both forms.
 */

const require = createRequire(import.meta.url);

/**
 * The directory of an installed driver, from its entry: none of them exports its `package.json`. The entry is a real
 * path, so an alias is under the package's own name (`sqlite3-5` is `.pnpm/sqlite3@5.1.7/node_modules/sqlite3`).
 */
function packageDir(name: string): string {
  const entry = require.resolve(name);
  const modules = `${sep}node_modules${sep}`;
  const at = entry.lastIndexOf(modules) + modules.length;
  return entry.slice(0, entry.indexOf(sep, at));
}

const drivers = {
  pg: packageDir("pg"),
  mysql2: packageDir("mysql2"),
  "better-sqlite3": packageDir("better-sqlite3"),
  libsql: packageDir("libsql"),
  mongodb: packageDir("mongodb"),
  // MikroORM 6 pins node-sqlite3 5.
  "sqlite3-5": packageDir("sqlite3-5"),
};

/**
 * The runner puts the package store on `NODE_PATH`, so every driver resolves from anywhere in this process, and the
 * question of an application that has none at its root cannot be asked. Node reads the variable once at start, so it
 * is read again here, empty: the runner starts one process per file.
 */
beforeAll(() => {
  process.env.NODE_PATH = "";
  (Module as unknown as { _initPaths: () => void })._initPaths();
});

let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "downtrace-mikro-orm-")));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Wrapper {
  name: string;
  version: string;
  /** The driver the package depends on, and the installed package that is it. */
  driver: string;
  installed: keyof typeof drivers;
}

interface App {
  from: string;
  /** Loads the driver the way the MikroORM package does, from where that package is. */
  loadThroughWrapper: () => void;
}

/** An application whose `node_modules` pnpm wrote: a link to the MikroORM package, and nothing else. */
async function pnpmApp(wrapper: Wrapper): Promise<App> {
  const dir = await mkdtemp(join(root, "app-"));
  const store = join(
    dir,
    "node_modules",
    ".pnpm",
    `${wrapper.name.replace("/", "+")}@${wrapper.version}`,
    "node_modules",
  );
  const own = join(store, wrapper.name);
  await mkdir(own, { recursive: true });
  const esm = wrapper.version.startsWith("7.");
  await writeFile(
    join(own, "package.json"),
    JSON.stringify({
      name: wrapper.name,
      version: wrapper.version,
      ...(esm
        ? { type: "module", exports: { ".": "./index.js", "./package.json": "./package.json" } }
        : {
            main: "index.js",
            exports: { ".": { import: "./index.mjs", require: "./index.js" }, "./package.json": "./package.json" },
          }),
      dependencies: { [wrapper.driver]: "pinned" },
    }),
  );
  await writeFile(join(own, "index.js"), esm ? `import "${wrapper.driver}";` : `require("${wrapper.driver}");`);
  await symlink(drivers[wrapper.installed], join(store, wrapper.driver), "dir");
  await mkdir(join(dir, "node_modules", "@mikro-orm"), { recursive: true });
  await symlink(own, join(dir, "node_modules", wrapper.name), "dir");
  const from = join(dir, "dist", "server.js");
  return { from, loadThroughWrapper: () => createRequire(join(own, "index.js"))(wrapper.driver) };
}

const handed: unknown[] = [];
const silent = { warn: () => {}, debug: () => {} } as Logger;
const deps = (log: Logger = silent) => ({
  log,
  internalError: (err: unknown): void => {
    handed.push(err);
  },
});

type Arm = (deps: { log: Logger; internalError: (err: unknown) => void; from: string }) => Armed;

/** Each MikroORM package for a database whose driver the instrumentation observes, with the observer for it. */
const WRAPPERS: [Wrapper, Arm][] = [
  [{ name: "@mikro-orm/postgresql", version: "7.2.5", driver: "pg", installed: "pg" }, armPg],
  [{ name: "@mikro-orm/mysql", version: "7.2.5", driver: "mysql2", installed: "mysql2" }, armMysql],
  [{ name: "@mikro-orm/sqlite", version: "7.2.5", driver: "better-sqlite3", installed: "better-sqlite3" }, armSqlite],
  [{ name: "@mikro-orm/libsql", version: "7.2.5", driver: "libsql", installed: "libsql" }, armSqlite],
  [{ name: "@mikro-orm/mongodb", version: "7.2.5", driver: "mongodb", installed: "mongodb" }, armMongo],
  [{ name: "@mikro-orm/sqlite", version: "6.6.17", driver: "sqlite3", installed: "sqlite3-5" }, armSqlite],
  [
    { name: "@mikro-orm/better-sqlite", version: "6.6.17", driver: "better-sqlite3", installed: "better-sqlite3" },
    armSqlite,
  ],
];

describe("the driver a MikroORM package brings", () => {
  it.each(WRAPPERS)(
    "is found beside $name $version, where the application's root has no $driver",
    async (wrapper, arm) => {
      const app = await pnpmApp(wrapper);
      expect(() => createRequire(app.from).resolve(wrapper.driver), "pnpm gives the root nothing else").toThrow();

      const armed = arm({ ...deps(), from: app.from });
      expect(armed.state, "MikroORM's copy is a driver to observe").toBe("on");
      expect(handed.splice(0)).toEqual([]);
    },
  );

  /**
   * Once per driver: the drivers are real modules, and a module this process has loaded and patched once stays so for
   * the next layout that links the same one.
   */
  const once = WRAPPERS.filter(([wrapper], i) => WRAPPERS.findIndex(([w]) => w.installed === wrapper.installed) === i);
  it.each(once)("patches the $driver that $name loads, from the first request after its load", async (wrapper, arm) => {
    const app = await pnpmApp(wrapper);
    const lines: string[] = [];
    const armed = arm({ ...deps({ warn: () => {}, debug: (line) => lines.push(line) }), from: app.from });
    expect(armed.attach(), "nothing is loaded yet: the attach waits").toBe(false);

    app.loadThroughWrapper();
    expect(armed.attach()).toBe(true);
    const said = lines.filter((line) => /^instrumented /.test(line));
    expect(said, `${wrapper.driver} is patched, and once`).toHaveLength(1);
    expect(handed.splice(0)).toEqual([]);
  });
});
