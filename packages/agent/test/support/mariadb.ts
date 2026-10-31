import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The copies of `mariadb` the tests have: 3.4, whose modules are CommonJS, as Prisma's adapter brings it up to
 * Prisma 7.9, and 3.5, whose modules are ESM, as every `import` of it loads them.
 */
export type MariadbCopy = "mariadb34" | "mariadb";

/** A copy of the driver: its two APIs, and the core classes they both run every query through. */
export interface Mariadb {
  /** `import mariadb from "mariadb"`: promises. */
  // biome-ignore lint/suspicious/noExplicitAny: the driver's own types are not what these tests are about
  promise: any;
  /** `mariadb/callback`: callbacks. */
  // biome-ignore lint/suspicious/noExplicitAny: as above
  callback: any;
  /** `lib/connection.js`: the connection every API wraps. */
  Connection: unknown;
  /** `lib/pool.js`: the pool every API wraps. */
  Pool: unknown;
  /** `lib/connection-callback.js`: the callback API, whose `query` builds its command itself. */
  ConnectionCallback: unknown;
  /** The directory of the package. */
  root: string;
}

const require = createRequire(import.meta.url);

/** The directory of a copy: `require` resolves 3.4's `promise.js` and 3.5's `dist/promise.cjs`. */
export function rootOf(copy: MariadbCopy): string {
  const resolved = require.resolve(copy);
  const dir = path.dirname(resolved);
  return path.basename(dir) === "dist" ? path.dirname(dir) : dir;
}

/**
 * A copy of the driver. 3.4 is required afresh, with classes of its own that no other test has patched; 3.5 is
 * imported, and an ES module is loaded once per process, so its classes are the same for every test that asks.
 */
export async function loadMariadb(copy: MariadbCopy): Promise<Mariadb> {
  const root = rootOf(copy);
  if (copy === "mariadb34") {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(root + path.sep)) delete require.cache[key];
    }
    return {
      promise: require(path.join(root, "promise.js")),
      callback: require(path.join(root, "callback.js")),
      Connection: require(path.join(root, "lib", "connection.js")),
      Pool: require(path.join(root, "lib", "pool.js")),
      ConnectionCallback: require(path.join(root, "lib", "connection-callback.js")),
      root,
    };
  }
  const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
  return {
    promise: (await load("promise.js")).default,
    callback: (await load("callback.js")).default,
    Connection: (await load("lib/connection.js")).default,
    Pool: (await load("lib/pool.js")).default,
    ConnectionCallback: (await load("lib/connection-callback.js")).default,
    root,
  };
}
