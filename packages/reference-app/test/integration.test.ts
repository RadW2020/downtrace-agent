import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReferenceApp, type ReferenceApp, type ReferenceAppOptions } from "../src/index.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Skipping without a database is right on a development machine and wrong in CI: a skipped test does not go red,
// it goes green, so the job would pass without running any of these and nothing would say so (gh-143).
// DOWNTRACE_REQUIRE_DB is set by the `test:integration` script and means this run was asked for these tests —
// `vitest run` with no filter loads this file too, and the `node` job has no database on purpose. Deliberately a
// local copy of what `packages/bench` has: two packages should not depend on each other for a test policy.
if (!DATABASE_URL) {
  if (process.env.DOWNTRACE_REQUIRE_DB && process.env.GITHUB_ACTIONS) {
    throw new Error(
      "DATABASE_URL is not set, and in CI a test that cannot run is a failure: this job would have passed without " +
        "running its integration tests",
    );
  }
  console.warn(
    "[reference-app] DATABASE_URL not set: skipping integration tests (run `make dev` or export DATABASE_URL/REDIS_URL)",
  );
}

const JSON_HEADERS = { "content-type": "application/json" };
const CART = Array.from({ length: 12 }, (_, i) => ({ productId: i + 1, quantity: 1 }));

function boot(overrides: ReferenceAppOptions = {}): Promise<{ ref: ReferenceApp; base: string }> {
  const ref = createReferenceApp({
    port: 0,
    providerPort: 0,
    databaseUrl: DATABASE_URL ?? "",
    redisUrl: REDIS_URL,
    appVersion: "test-1",
    regressions: "",
    ...overrides,
  });
  return ref.start().then(({ port }) => ({ ref, base: `http://127.0.0.1:${port}` }));
}

/** Stats for one endpoint; fails loudly if nothing was recorded for it. */
async function endpointStats(
  stats: () => Promise<Record<string, Record<string, unknown>>>,
  key: string,
): Promise<Record<string, unknown>> {
  const s = (await stats())[key];
  if (!s) throw new Error(`no stats recorded for ${key}`);
  return s;
}

function client(base: string) {
  return {
    get: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers }),
    checkout: () =>
      fetch(`${base}/checkout`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ userId: 1, items: CART }),
      }),
    stats: async () =>
      (await fetch(`${base}/__admin/stats`)).json() as Promise<Record<string, Record<string, unknown>>>,
    resetStats: () => fetch(`${base}/__admin/stats/reset`, { method: "POST" }),
    resetDb: () => fetch(`${base}/__admin/db/reset`, { method: "POST" }),
    setRegressions: (patch: unknown) =>
      fetch(`${base}/__admin/regressions`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(patch) }),
  };
}

async function median(times: number, fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

describe.skipIf(!DATABASE_URL)("reference app (integration)", () => {
  let ref: ReferenceApp;
  let api: ReturnType<typeof client>;

  beforeAll(async () => {
    const booted = await boot();
    ref = booted.ref;
    api = client(booted.base);
  });
  afterAll(() => ref.stop());
  beforeEach(async () => {
    ref.regressions.reset();
    ref.provider.control.delayMs = 0;
    ref.provider.control.failureRate = 0;
    await api.resetStats();
  });

  it("healthz reports the configured version", async () => {
    const res = await api.get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "test-1" });
  });

  it("normal checkout: 10–15 queries, 2 provider calls, 0 retries, 3 redis ops", async () => {
    const res = await api.checkout();
    expect(res.status).toBe(201);
    const s = await endpointStats(api.stats, "POST /checkout");
    expect(s.requests).toBe(1);
    expect(s.sqlQueries).toBeGreaterThanOrEqual(10);
    expect(s.sqlQueries).toBeLessThanOrEqual(15);
    expect(s.providerCalls).toBe(2);
    expect(s.providerRetries).toBe(0);
    expect(s.redisOps).toBe(3);
  });

  it("n_plus_one multiplies queries by at least 4x; provider and redis unchanged", async () => {
    await api.checkout();
    const base = await endpointStats(api.stats, "POST /checkout");
    await api.resetStats();

    await api.setRegressions({ n_plus_one: { enabled: true } });
    expect((await api.checkout()).status).toBe(201);
    const regressed = await endpointStats(api.stats, "POST /checkout");

    expect(regressed.sqlQueries as number).toBeGreaterThanOrEqual(4 * (base.sqlQueries as number));
    expect(regressed.providerCalls).toBe(base.providerCalls);
    expect(regressed.redisOps).toBe(base.redisOps);
  });

  it("slow_dependency (300 ms) raises checkout median by ≥ 500 ms while /products stays within 20 ms", {
    timeout: 30_000,
  }, async () => {
    const baseCheckout = await median(5, () => api.checkout());
    const baseProducts = await median(5, () => api.get("/products"));

    await api.setRegressions({ slow_dependency: { enabled: true, params: { delayMs: 300 } } });
    const slowCheckout = await median(5, () => api.checkout());
    const slowProducts = await median(5, () => api.get("/products"));

    expect(slowCheckout - baseCheckout).toBeGreaterThanOrEqual(500);
    expect(Math.abs(slowProducts - baseProducts)).toBeLessThanOrEqual(20);
  });

  it("aggressive_retries under a slow dependency: ≥ 3 retries and a 502", async () => {
    await api.setRegressions({
      slow_dependency: { enabled: true, params: { delayMs: 300 } },
      aggressive_retries: { enabled: true, params: { timeoutMs: 100, retries: 3 } },
    });
    const res = await api.checkout();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("ProviderError");
    const s = await endpointStats(api.stats, "POST /checkout");
    expect(s.providerRetries as number).toBeGreaterThanOrEqual(3);
    expect((s.status as Record<string, number>)["5xx"]).toBe(1);
  });

  it("new_error with rate 1 fails GET /products/1 with InventoryMismatchError", async () => {
    await api.setRegressions({ new_error: { enabled: true, params: { rate: 1 } } });
    const res = await api.get("/products/1");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("InventoryMismatchError");
    const s = await endpointStats(api.stats, "GET /products/:id");
    expect((s.errors as Record<string, number>).InventoryMismatchError).toBe(1);
  });

  it("GET /me is served from Redis after the first call", async () => {
    await ref.cache.client.del("session:2"); // isolate from previous runs
    expect((await api.get("/me", { "x-user-id": "2" })).status).toBe(200);
    expect((await api.get("/me", { "x-user-id": "2" })).status).toBe(200);
    const s = await endpointStats(api.stats, "GET /me");
    expect(s.requests).toBe(2);
    expect(s.redisOps).toBe(3); // miss: GET+SET, hit: GET
    expect(s.sqlQueries).toBe(1);
  });

  it("GET /__admin/process reports cpu, memory and event loop utilization", async () => {
    const res = await api.get("/__admin/process");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pid: number;
      cpu: { user: number; system: number };
      memory: { rss: number; heapUsed: number };
      eventLoopUtilization: { idle: number; active: number; utilization: number };
      uptimeMs: number;
    };
    expect(body.pid).toBe(process.pid);
    expect(body.cpu.user).toBeGreaterThan(0);
    expect(body.memory.rss).toBeGreaterThan(0);
    expect(body.memory.heapUsed).toBeGreaterThan(0);
    expect(body.eventLoopUtilization.utilization).toBeGreaterThanOrEqual(0);
    expect(body.eventLoopUtilization.utilization).toBeLessThanOrEqual(1);
    expect(body.uptimeMs).toBeGreaterThan(0);
  });

  // The overhead benchmark compares rounds with each other, so every round has to start on the same database
  // (gh-140, ADR 0021). What must go is what a request writes; the catalogue has to survive, because the app
  // cannot serve anything without it and `migrate()` only tops it up with ON CONFLICT DO NOTHING.
  it("db/reset empties what requests write, keeps the catalogue and puts stock back", async () => {
    const count = async (table: string) =>
      Number((await ref.db.query<{ n: number }>(null, `SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n);
    const stock = async () =>
      Number((await ref.db.query<{ stock: number }>(null, "SELECT stock FROM products WHERE id = 1")).rows[0]?.stock);

    expect((await api.checkout()).status).toBe(201);
    expect(await count("orders")).toBeGreaterThan(0);
    expect(await count("order_items")).toBeGreaterThan(0);
    const stockAfterCheckout = await stock();

    expect((await api.resetDb()).status).toBe(204);

    for (const table of ["orders", "order_items", "payments", "order_events"]) {
      expect(await count(table)).toBe(0);
    }
    expect(await count("users")).toBeGreaterThan(0);
    expect(await count("products")).toBeGreaterThan(0);
    expect(await stock()).toBeGreaterThan(stockAfterCheckout);
    // And the app still works on the reset database, which is the point: the next round measures, it does not repair.
    expect((await api.checkout()).status).toBe(201);
  });

  it("REGRESSIONS env enables regressions at startup", async () => {
    const { ref: other, base } = await boot({ regressions: "n_plus_one" });
    try {
      const state = (await (await fetch(`${base}/__admin/regressions`)).json()) as Record<string, { enabled: boolean }>;
      expect(state.n_plus_one?.enabled).toBe(true);
      expect(
        Object.entries(state)
          .filter(([, v]) => v.enabled)
          .map(([k]) => k),
      ).toEqual(["n_plus_one"]);
    } finally {
      await other.stop();
    }
  });

  it("ADMIN_ENABLED=0 hides the admin surface", async () => {
    const { ref: other, base } = await boot({ adminEnabled: false });
    try {
      expect((await fetch(`${base}/__admin/stats`)).status).toBe(404);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    } finally {
      await other.stop();
    }
  });

  it("pool_leak with rate 1 and a pool of 3: the 4th checkout times out on the pool", { timeout: 30_000 }, async () => {
    const { ref: other, base } = await boot({ pgPoolMax: 3, pgConnectionTimeoutMs: 500, regressions: "pool_leak" });
    const leaky = client(base);
    try {
      other.regressions.update({ pool_leak: { params: { rate: 1 } } });
      for (let i = 0; i < 3; i++) expect((await leaky.checkout()).status).toBe(201);
      const fourth = await leaky.checkout();
      expect(fourth.status).toBe(503);
      expect(((await fourth.json()) as { error: string }).error).toBe("PoolTimeoutError");
      const s = await endpointStats(leaky.stats, "POST /checkout");
      expect(s.poolWaitMs as number).toBeGreaterThan(400);
    } finally {
      await other.stop();
    }
  });
});

describe.skipIf(!DATABASE_URL)("checkout under concurrency", () => {
  let ref: ReferenceApp;
  let base: string;
  beforeAll(async () => ({ ref, base } = await boot({ pgPoolMax: 10 })));
  afterAll(() => ref.stop());

  it("20 concurrent checkouts over the same products, carts in mixed order: all 201, no deadlock", async () => {
    const cart = Array.from({ length: 12 }, (_, i) => ({ productId: i + 1, quantity: 1 }));
    const reversed = [...cart].reverse();
    const statuses: number[] = [];
    for (let burst = 0; burst < 3; burst++) {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          fetch(`${base}/checkout`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: (i % 5) + 1, items: i % 2 ? cart : reversed }),
            signal: AbortSignal.timeout(15_000),
          }),
        ),
      );
      statuses.push(...responses.map((r) => r.status));
    }
    expect(
      statuses.filter((s) => s !== 201),
      `statuses: ${JSON.stringify(statuses)}`,
    ).toEqual([]);
  }, 90_000);
});
