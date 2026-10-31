// A CommonJS application that requires `pg`, and an ES module of its — drizzle-orm/node-postgres — that imports it
// during start-up, before the first request.
const pg = require("pg");

(async () => {
  const { serveOnce, spansOfOneQuery } = await import("./spans.mjs");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await import("pg");
  await serveOnce();
  console.log(JSON.stringify({ spans: await spansOfOneQuery(pg) }));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
