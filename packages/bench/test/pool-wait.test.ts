import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { poolWaitSince } from "../src/process-sampler.ts";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

/** Stand-in for the app's admin surface, recording what it was asked. */
async function startApp(handler: (url: string, method: string) => { status: number; body?: unknown }) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const { status, body } = handler(req.url ?? "", req.method ?? "");
    res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("poolWaitSince", () => {
  it("sums the wait across routes", async () => {
    const app = await startApp(() => ({
      status: 200,
      body: {
        "GET /products": { poolWaitMs: 12.5, maxPoolWaitMs: 4, maxPoolWaitAt: 1000, requests: 100 },
        "POST /checkout": { poolWaitMs: 340.25, maxPoolWaitMs: 91, maxPoolWaitAt: 2000, requests: 10 },
      },
    }));
    expect((await poolWaitSince(app.url, false)).totalMs).toBeCloseTo(352.75, 2);
    expect(app.seen).toEqual(["GET /__admin/stats"]);
  });

  // Which route waited longest is not the question; when the database stopped answering is (gh-177).
  it("keeps the single worst wait and its instant, not the worst route's total", async () => {
    const app = await startApp(() => ({
      status: 200,
      body: {
        "GET /products": { poolWaitMs: 900, maxPoolWaitMs: 4, maxPoolWaitAt: 1000 },
        "POST /checkout": { poolWaitMs: 91, maxPoolWaitMs: 91, maxPoolWaitAt: 2000 },
      },
    }));
    const wait = await poolWaitSince(app.url, false);
    expect(wait.maxMs).toBe(91);
    expect(wait.maxAt).toBe(2000);
  });

  // The warmup is where the app is cold on purpose; counting its waits would mix the start-up into the measurement.
  it("resets the counters when asked, and reports nothing then", async () => {
    const app = await startApp(() => ({ status: 204 }));
    expect(await poolWaitSince(app.url, true)).toEqual({ totalMs: 0, maxMs: 0, maxAt: undefined });
    expect(app.seen).toEqual(["POST /__admin/stats/reset"]);
  });

  // A route that never waited has no counter at all, which is not the same as a broken response.
  it("treats a missing counter as no wait", async () => {
    const app = await startApp(() => ({ status: 200, body: { "GET /healthz": { requests: 3 } } }));
    expect(await poolWaitSince(app.url, false)).toEqual({ totalMs: 0, maxMs: 0, maxAt: undefined });
  });

  it("throws instead of reporting zero when the app will not answer", async () => {
    const app = await startApp(() => ({ status: 500 }));
    await expect(poolWaitSince(app.url, false)).rejects.toThrow("/__admin/stats responded 500");
    await expect(poolWaitSince(app.url, true)).rejects.toThrow("/__admin/stats/reset responded 500");
  });
});
