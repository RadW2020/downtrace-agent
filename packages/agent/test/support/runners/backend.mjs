import http from "node:http";

/**
 * A backend small enough to start in a test and real enough to be profiled: every route it serves makes one
 * outgoing HTTP call to a second server, which is an operation of the route, and a profile holds a route only
 * when it ran something. Plain `node:http`, no framework and no database, so what a run keeps of its profile is
 * asked of the instrumentation alone (DT-79).
 *
 * It is imported by the suites the runners run (`*.vitest.mjs`, `*.node.mjs`) and by the processes
 * `exit.test.ts` starts, which is why it is a plain module and not a test: nothing here is collected by a run.
 */

function listening(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closed(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Starts the backend and the server it calls. `base` is where to send requests; `stop` closes both. */
export async function startBackend() {
  const provider = http.createServer((_req, res) => res.end("ok"));
  const providerPort = await listening(provider);
  const app = http.createServer(async (_req, res) => {
    const answer = await fetch(`http://127.0.0.1:${providerPort}/authorize`);
    await answer.arrayBuffer();
    res.end("ok");
  });
  const port = await listening(app);
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => Promise.all([closed(app), closed(provider)]),
  };
}

/** Sends one request to each path, one after another, and waits for every answer. */
export async function visit(backend, paths) {
  for (const path of paths) {
    const answer = await fetch(backend.base + path);
    await answer.arrayBuffer();
  }
}

/** The paths every suite visits, and the process of `exit.test.ts` with them. */
export const COMMON_PATHS = ["/products", "/products/1", "/me"];

/** One suite of a run: starts the backend, visits the common routes and one of its own, and stops. */
export async function suite(ownPath) {
  const backend = await startBackend();
  try {
    await visit(backend, [...COMMON_PATHS, ownPath]);
  } finally {
    await backend.stop();
  }
}
