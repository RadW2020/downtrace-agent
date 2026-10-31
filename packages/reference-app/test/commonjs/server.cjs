/**
 * A CommonJS application, for the one half of the coexistence test (ESC-16) the reference app cannot show: the
 * reference app is an ES module application, and here the driver is loaded by `require`, where only the tracker's
 * hook for CommonJS sees it. Express 5 and `pg`, both required, and one route that runs one query.
 *
 * The tracker is required on the first line, as its documentation asks a CommonJS application to load it. When it
 * is preloaded with `node --require ./test/commonjs/instrument.cjs` as well, which the same documentation allows,
 * this line is a cache hit and initialises nothing twice: that is what lets one file serve both load orders.
 */
require("./instrument.cjs");

const express = require("express");
const pg = require("pg");

/** It needs no schema: what is counted is the query and its connection, not what it reads. */
const QUERY = "SELECT 1 AS one";
const SHUTDOWN_DEADLINE_MS = 5_000;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

app.get("/products", async (_req, res) => {
  const { rows } = await pool.query(QUERY);
  res.json(rows);
});

const server = app.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ msg: "commonjs app listening", port: server.address().port }));
});

// Closing everything and letting the event loop empty, as `src/main.ts` does and for its reason: the
// instrumentation's last flush runs as the process ends, and `process.exit()` would race it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    server.close();
    pool.end().catch(() => process.exit(1));
  });
}
