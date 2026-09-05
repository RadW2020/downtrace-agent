import { mulberry32 } from "./prng.ts";
import { type Percentiles, percentiles, round } from "./stats.ts";

export const ENDPOINTS = ["GET /products", "GET /products/:id", "GET /me", "POST /checkout"] as const;
export type EndpointName = (typeof ENDPOINTS)[number];
export type Mix = Record<EndpointName, number>;

/** Default traffic mix (weights): mostly reads, one checkout in ten. */
export const DEFAULT_MIX: Mix = {
  "GET /products": 40,
  "GET /products/:id": 30,
  "GET /me": 20,
  "POST /checkout": 10,
};

const USERS = 5;
const PRODUCTS = 50;
const CART = Array.from({ length: 12 }, (_, i) => ({ productId: i + 1, quantity: 1 }));

export interface PlannedRequest {
  endpoint: EndpointName;
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The exact sequence of requests for a seed: both benchmark variants receive identical traffic. */
export function buildPlan(seed: number, count: number, mix: Mix = DEFAULT_MIX): PlannedRequest[] {
  const rand = mulberry32(seed);
  const total = ENDPOINTS.reduce((s, e) => s + mix[e], 0);
  const plan: PlannedRequest[] = [];
  for (let i = 0; i < count; i++) {
    let pick = rand() * total;
    let endpoint: EndpointName = "POST /checkout";
    for (const e of ENDPOINTS) {
      if (pick < mix[e]) {
        endpoint = e;
        break;
      }
      pick -= mix[e];
    }
    const userId = 1 + Math.floor(rand() * USERS);
    const productId = 1 + Math.floor(rand() * PRODUCTS);
    plan.push(toRequest(endpoint, userId, productId));
  }
  return plan;
}

function toRequest(endpoint: EndpointName, userId: number, productId: number): PlannedRequest {
  switch (endpoint) {
    case "GET /products":
      return { endpoint, method: "GET", path: "/products" };
    case "GET /products/:id":
      return { endpoint, method: "GET", path: `/products/${productId}` };
    case "GET /me":
      return { endpoint, method: "GET", path: "/me", headers: { "x-user-id": String(userId) } };
    case "POST /checkout":
      return {
        endpoint,
        method: "POST",
        path: "/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, items: CART }),
      };
  }
}

export interface LoadOptions {
  baseUrl: string;
  rps: number;
  durationSec: number;
  seed: number;
  mix?: Mix;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
}

export interface EndpointReport extends Percentiles {
  count: number;
  errors: number;
}

export interface LoadReport {
  targetRps: number;
  achievedRps: number;
  requested: number;
  completed: number;
  errors: number;
  /** Failed requests by outcome: HTTP status ("502", "503"…), "timeout" or "network". */
  errorStatuses?: Record<string, number> | undefined;
  elapsedMs: number;
  overall: Percentiles;
  byEndpoint: Record<string, EndpointReport>;
  /** Every completed request's latency (ms), unsorted; kept in memory for pooled statistics, stripped from JSON reports. */
  samples: number[];
}

interface Sample {
  endpoint: EndpointName;
  ms: number;
  error: boolean;
  /** Outcome for failed requests: status code, "timeout" or "network". */
  outcome?: string | undefined;
}

/**
 * Open-loop load: requests are fired on a fixed schedule regardless of how fast
 * the server answers, and latency is measured from the *scheduled* send time,
 * so a server that falls behind shows up as queueing latency instead of hiding
 * behind a slower client (no coordinated omission).
 */
export async function runLoad(opts: LoadOptions): Promise<LoadReport> {
  const plan = buildPlan(opts.seed, Math.round(opts.rps * opts.durationSec), opts.mix);
  const intervalMs = 1000 / opts.rps;
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const samples: Sample[] = [];
  const inflight = new Set<Promise<void>>();

  const start = performance.now();
  for (const [i, req] of plan.entries()) {
    const due = start + i * intervalMs;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    const p = fire(opts.baseUrl, req, timeoutMs)
      .then((outcome) => {
        samples.push({ endpoint: req.endpoint, ms: performance.now() - due, error: outcome !== "ok", outcome });
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);
  const elapsedMs = performance.now() - start;

  const byEndpoint: Record<string, EndpointReport> = {};
  for (const e of ENDPOINTS) {
    const s = samples.filter((x) => x.endpoint === e);
    if (s.length === 0) continue;
    byEndpoint[e] = {
      ...roundPct(percentiles(s.map((x) => x.ms))),
      count: s.length,
      errors: s.filter((x) => x.error).length,
    };
  }
  const errorStatuses: Record<string, number> = {};
  for (const x of samples)
    if (x.error) errorStatuses[x.outcome ?? "unknown"] = (errorStatuses[x.outcome ?? "unknown"] ?? 0) + 1;
  return {
    targetRps: opts.rps,
    achievedRps: round((samples.length / elapsedMs) * 1000),
    requested: plan.length,
    completed: samples.length,
    errors: samples.filter((x) => x.error).length,
    errorStatuses,
    elapsedMs: round(elapsedMs),
    overall: roundPct(percentiles(samples.map((x) => x.ms))),
    byEndpoint,
    samples: samples.map((x) => x.ms),
  };
}

/** "ok", or why the request failed: its HTTP status, "timeout" or "network". */
async function fire(baseUrl: string, req: PlannedRequest, timeoutMs: number): Promise<string> {
  try {
    const init: RequestInit = { method: req.method, signal: AbortSignal.timeout(timeoutMs) };
    if (req.headers) init.headers = req.headers;
    if (req.body !== undefined) init.body = req.body;
    const res = await fetch(baseUrl + req.path, init);
    await res.arrayBuffer(); // drain so the connection is reusable
    return res.ok ? "ok" : String(res.status);
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
  }
}

function roundPct(p: Percentiles): Percentiles {
  return { p50: round(p.p50), p95: round(p.p95), p99: round(p.p99), max: round(p.max) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
