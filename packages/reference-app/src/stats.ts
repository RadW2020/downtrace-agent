/**
 * The app's own ground truth: what each request actually did. Independent of
 * any agent so tests and evals have something to compare against.
 */
export interface RequestCounters {
  sqlQueries: number;
  providerCalls: number;
  providerRetries: number;
  redisOps: number;
  poolWaitMs: number;
  errors: Record<string, number>;
}

export interface EndpointStats extends RequestCounters {
  requests: number;
  status: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
  totalDurationMs: number;
}

declare global {
  namespace Express {
    interface Locals {
      ctx: RequestCounters;
    }
  }
}

export function newCounters(): RequestCounters {
  return { sqlQueries: 0, providerCalls: 0, providerRetries: 0, redisOps: 0, poolWaitMs: 0, errors: {} };
}

export function countError(ctx: RequestCounters | undefined, name: string): void {
  if (!ctx) return;
  ctx.errors[name] = (ctx.errors[name] ?? 0) + 1;
}

export class Stats {
  private endpoints = new Map<string, EndpointStats>();

  record(endpoint: string, statusCode: number, durationMs: number, c: RequestCounters): void {
    const e = this.endpoints.get(endpoint) ?? emptyEndpoint();
    e.requests += 1;
    e.status[statusClass(statusCode)] += 1;
    e.totalDurationMs += durationMs;
    e.sqlQueries += c.sqlQueries;
    e.providerCalls += c.providerCalls;
    e.providerRetries += c.providerRetries;
    e.redisOps += c.redisOps;
    e.poolWaitMs += c.poolWaitMs;
    for (const [name, n] of Object.entries(c.errors)) e.errors[name] = (e.errors[name] ?? 0) + n;
    this.endpoints.set(endpoint, e);
  }

  snapshot(): Record<string, EndpointStats> {
    return Object.fromEntries([...this.endpoints].map(([k, v]) => [k, structuredClone(v)]));
  }

  reset(): void {
    this.endpoints.clear();
  }
}

function emptyEndpoint(): EndpointStats {
  return { ...newCounters(), requests: 0, status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, totalDurationMs: 0 };
}

function statusClass(code: number): keyof EndpointStats["status"] {
  if (code >= 500) return "5xx";
  if (code >= 400) return "4xx";
  if (code >= 300) return "3xx";
  return "2xx";
}
