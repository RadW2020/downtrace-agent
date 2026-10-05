import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The shapes a `node_modules` takes around `@prisma/adapter-pg` (DT-92), written to disk so that the resolution and
 * the module cache are the real ones: what is being tested is where the adapter's `pg` is found from, and a stub for
 * that would be a stub for the answer.
 *
 * From `@prisma/adapter-pg` 6.11 and in 7.x, `pg` is a dependency of the adapter and not a peer of it, so the adapter
 * brings the `pg` it uses. Where that copy sits depends on the package manager, and the lab measured two layouts in
 * which it is not the one the application resolves:
 *
 * - **pnpm**, whose `node_modules` holds only what the application declares: an application that lists the adapter and
 *   not `pg` has no `pg` at its root, and the adapter's sits beside the adapter in the store.
 * - **npm with a `pg` of the application's** that does not satisfy the adapter's range (`pg@8.11.5` and an adapter that
 *   wants `^8.16.3`): the adapter gets a copy of its own, nested inside it, and the two are two modules with two
 *   prototypes.
 *
 * And the third, where there is nothing to find: **hoisted**, one `pg` that both resolve.
 */

/** A stand-in for `pg`, with the two classes the observer patches and a host and port on the client it hands out. */
export const DRIVER = `
  class Client {
    constructor() { this.host = "db.internal"; this.port = 5432; }
    query() { return Promise.resolve({ rows: [] }); }
  }
  class Pool {
    connect() { return new Promise((resolve) => setTimeout(() => resolve(new Client()), 1)); }
  }
  module.exports = { Client, Pool };
`;

/**
 * The adapter, as far as `pg` is concerned: it requires it from where it is and runs what it is given on a client.
 * It has the real package's `exports` map, which is why nothing resolves its `package.json`: that is not exported.
 */
const ADAPTER = `
  const pg = require("pg");
  class PrismaPg {
    constructor() { this.client = new pg.Client(); }
    queryRaw(sql) { return this.client.query(sql); }
  }
  module.exports = { PrismaPg };
`;

/** The same for an application that imports it, which is how Prisma 7's ESM client reaches it. */
const ADAPTER_ESM = `
  import pg from "pg";
  export class PrismaPg {
    constructor() { this.client = new pg.Client(); }
    queryRaw(sql) { return this.client.query(sql); }
  }
`;

export type Layout = "pnpm" | "nested" | "hoisted";

export interface Tree {
  /** The directory that holds everything. */
  dir: string;
  /** The file the agent resolves from: the application's entry. */
  from: string;
  /** The application's own require, which loads what the application loads. */
  appRequire: NodeRequire;
  /** Where the adapter's own copy of `pg` is, when it has one: the path the module cache keys it by. */
  adapterPg: string | undefined;
  cleanup: () => Promise<void>;
}

export interface TreeOptions {
  /** The version of the `pg` in the application's own `node_modules`, or none. */
  app?: string | undefined;
  /** Whether `@prisma/adapter-pg` is installed, and how the package manager laid it out. */
  adapter?: Layout | undefined;
  /** What the adapter's `pg` is, when it is not the stand-in: a copy that cannot be loaded, say. */
  adapterDriver?: string | undefined;
  /** The version of the adapter's own copy; the application's, when the layout hoists them to one. */
  adapterVersion?: string | undefined;
}

async function writePackage(
  dir: string,
  files: {
    name: string;
    version: string;
    main: string;
    source: string;
    exports?: unknown;
    /** Other files of the package, by path inside it. */
    more?: Record<string, string>;
  },
): Promise<void> {
  await mkdir(dirname(join(dir, files.main)), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: files.name, version: files.version, main: files.main, exports: files.exports }),
  );
  await writeFile(join(dir, files.main), files.source);
  for (const [path, source] of Object.entries(files.more ?? {})) await writeFile(join(dir, path), source);
}

const ADAPTER_EXPORTS = { ".": { require: "./dist/index.js", import: "./dist/index.mjs" } };

export async function makeTree(options: TreeOptions): Promise<Tree> {
  const dir = await mkdtemp(join(tmpdir(), "downtrace-prisma-layout-"));
  const modules = join(dir, "node_modules");
  const driver = options.adapterDriver ?? DRIVER;
  let adapterPg: string | undefined;

  if (options.app !== undefined) {
    await writePackage(join(modules, "pg"), { name: "pg", version: options.app, main: "index.js", source: DRIVER });
  }

  const adapter = {
    name: "@prisma/adapter-pg",
    version: "7.10.0",
    main: "dist/index.js",
    source: ADAPTER,
    exports: ADAPTER_EXPORTS,
    more: { "dist/index.mjs": ADAPTER_ESM },
  };
  switch (options.adapter) {
    case undefined:
      break;
    case "hoisted":
      await writePackage(join(modules, "@prisma", "adapter-pg"), adapter);
      break;
    case "nested": {
      const own = join(modules, "@prisma", "adapter-pg");
      await writePackage(own, adapter);
      await writePackage(join(own, "node_modules", "pg"), {
        name: "pg",
        version: options.adapterVersion ?? "8.99.0",
        main: "index.js",
        source: driver,
      });
      adapterPg = join(own, "node_modules", "pg", "index.js");
      break;
    }
    case "pnpm": {
      // The store: the adapter and its dependencies side by side, and the application's `node_modules` holding
      // only a link to the adapter, which is all pnpm gives it.
      const store = join(modules, ".pnpm", "adapter-pg@7.10.0", "node_modules");
      await writePackage(join(store, "@prisma", "adapter-pg"), adapter);
      await writePackage(join(store, "pg"), {
        name: "pg",
        version: options.adapterVersion ?? "8.99.0",
        main: "index.js",
        source: driver,
      });
      await mkdir(join(modules, "@prisma"), { recursive: true });
      await symlink(join(store, "@prisma", "adapter-pg"), join(modules, "@prisma", "adapter-pg"), "dir");
      adapterPg = join(store, "pg", "index.js");
      break;
    }
  }

  const from = join(dir, "app.js");
  return {
    dir,
    from,
    appRequire: createRequire(from),
    // The module cache keys a module by its real path, and a temporary directory may be reached through a link.
    adapterPg: adapterPg === undefined ? undefined : createRequire(adapterPg).resolve(adapterPg),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
