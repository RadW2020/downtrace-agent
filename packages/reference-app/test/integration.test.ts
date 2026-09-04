import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReferenceApp, type ReferenceApp, type ReferenceAppOptions } from "../src/index.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

if (!DATABASE_URL) {
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
