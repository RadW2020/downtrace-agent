import { ProviderError } from "./errors.ts";
import type { Regressions } from "./regressions.ts";
import type { RequestCounters } from "./stats.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export interface ProviderResponse {
  ok: boolean;
  op: string;
  ref: string;
}

/** Outgoing HTTP client for the provider; timeout and retries come from `aggressive_retries`. */
export class ProviderClient {
  private readonly baseUrl: () => string;
  private readonly regressions: Regressions;

  constructor(baseUrl: () => string, regressions: Regressions) {
    this.baseUrl = baseUrl;
    this.regressions = regressions;
  }

  async call(ctx: RequestCounters, path: "/authorize" | "/capture", body: unknown): Promise<ProviderResponse> {
    ctx.providerCalls += 1;
    const aggressive = this.regressions.isEnabled("aggressive_retries");
    const { timeoutMs, retries } = aggressive
      ? this.regressions.params("aggressive_retries")
      : { timeoutMs: DEFAULT_TIMEOUT_MS, retries: 0 };

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) ctx.providerRetries += 1; // no backoff: intentionally the regression
      try {
        const res = await fetch(this.baseUrl() + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`provider responded ${res.status}`);
        return (await res.json()) as ProviderResponse;
      } catch (err) {
        lastError = err;
      }
    }
    throw new ProviderError(`provider call ${path} failed after ${retries + 1} attempt(s)`, lastError);
  }
}
