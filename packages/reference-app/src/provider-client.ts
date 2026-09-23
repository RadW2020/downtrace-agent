import { captureException } from "@downtrace/agent";
import { ProviderError } from "./errors.ts";
import type { Regressions } from "./regressions.ts";
import type { RequestCounters } from "./stats.ts";
import type { Tracker } from "./tracker.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export interface ProviderResponse {
  ok: boolean;
  op: string;
  ref: string;
}

export interface ProviderClientDeps {
  baseUrl: () => string;
  regressions: Regressions;
  /** The error tracker this process also runs, when it runs one: the handled error goes to both (ESC-16). */
  tracker?: Tracker | undefined;
}

/** Outgoing HTTP client for the provider; timeout and retries come from `aggressive_retries`. */
export class ProviderClient {
  private readonly baseUrl: () => string;
  private readonly regressions: Regressions;
  private readonly tracker: Tracker | undefined;

  constructor(deps: ProviderClientDeps) {
    this.baseUrl = deps.baseUrl;
    this.regressions = deps.regressions;
    this.tracker = deps.tracker;
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
        // A failure the application handles by retrying, which is exactly the kind of error no hook can see:
        // from the outside the call was made, it failed, and the request carried on. This is what
        // `captureException` is for (ERR-02), and the context is structural — which attempt, which
        // operation — and never what was being paid for.
        //
        // Beside the tracker, both are told, with the same error and the same context: that is what a
        // migration looks like while it lasts, and finishing it is deleting one of these two lines (ESC-16).
        const context = { operation: path.slice(1), attempt: attempt + 1, willRetry: attempt < retries };
        captureException(err, context);
        this.tracker?.captureException(err, context);
        lastError = err;
      }
    }
    throw new ProviderError(`provider call ${path} failed after ${retries + 1} attempt(s)`, lastError);
  }
}
