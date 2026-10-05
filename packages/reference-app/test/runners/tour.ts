import { createReferenceApp } from "../../src/index.ts";

/**
 * The routes the reference app has, called once each, the way a test run calls them. The suites of this directory
 * are what `runners.integration.test.ts` hands to a real test runner, one runner at a time, with the
 * instrumentation loaded and its batches written to a file (DT-79).
 *
 * Not named `*.test.ts`: the suite that collects this package's tests must not collect these, which are meant to run
 * inside another run.
 */

/** What a call to each route is expected to profile: `POST /checkout` is the one that makes all three kinds. */
export const ROUTES = ["GET /products", "GET /products/:id", "GET /me", "POST /checkout"] as const;

export async function tour(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set: the tour needs the database the integration tests use");
  const ref = createReferenceApp({
    port: 0,
    providerPort: 0,
    databaseUrl,
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    appVersion: "tour",
    regressions: "",
  });
  const { port } = await ref.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const path of ["/products", "/products/1", "/me"]) {
      const res = await fetch(base + path);
      if (res.status !== 200) throw new Error(`GET ${path} answered ${res.status}`);
      await res.arrayBuffer();
    }
    const cart = Array.from({ length: 12 }, (_, i) => ({ productId: i + 1, quantity: 1 }));
    const res = await fetch(`${base}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: 1, items: cart }),
    });
    if (res.status !== 201) throw new Error(`POST /checkout answered ${res.status}`);
    await res.arrayBuffer();
  } finally {
    await ref.stop();
  }
}
