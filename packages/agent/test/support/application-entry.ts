import { fileURLToPath } from "node:url";

/**
 * The application of this package's tests is this package: what it imports — `express`, `pg`, `mysql2`, `koa` — is
 * what an agent a test starts must find from the application's entry, which `applicationEntry()` reads off
 * `process.argv[1]`. In a Vitest worker that is Vitest's own file, in pnpm's store, from where those packages
 * resolve only through pnpm's hidden hoisting: which is no promise, and which adding Jest to these tests undid for
 * `express`, whose instances the peers Jest brings split in two. So the entry is a file of this package, as an
 * application's is one of its own. A test that asks about the entry itself passes its own `argv`.
 */
process.argv[1] = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
