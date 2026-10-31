// An ES module application that imports `pg`, and a CommonJS dependency of its that requires it too — knex's client,
// TypeORM's driver, connect-pg-simple — before the first request or after it (`REQUIRE`).
import { createRequire } from "node:module";
import pg from "pg";
import { serveOnce, spansOfOneQuery } from "./spans.mjs";

const requirePg = () => createRequire(import.meta.url)("pg");
await new Promise((resolve) => setTimeout(resolve, 10));
if (process.env.REQUIRE === "before") requirePg();
await serveOnce();
if (process.env.REQUIRE === "after") requirePg();
console.log(JSON.stringify({ spans: await spansOfOneQuery(pg) }));
process.exit(0);
