import * as Sentry from "@sentry/node";

/**
 * Serves one request, so that the instrumentation's attach at the first request has run, and then counts the `pg`
 * query spans the tracker starts for one query. No database: the query fails to connect, and its span is started all
 * the same.
 */
export async function serveOnce() {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  server.close();
}

export async function spansOfOneQuery(pg) {
  let spans = 0;
  Sentry.getClient().on("spanStart", (span) => {
    if (String(Sentry.spanToJSON(span).description).startsWith("pg.query")) spans += 1;
  });
  await Sentry.startSpan({ name: "root" }, async () => {
    const client = new pg.Client({ host: "127.0.0.1", port: 9, connectionTimeoutMillis: 200 });
    client.connect().catch(() => {});
    await client.query("SELECT 1").catch(() => {});
  });
  return spans;
}
