import {
  AGGREGATES_PATH,
  type AgentInfo,
  type AggregatesBatch,
  type DeployInfo,
  type InstanceInfo,
  type Interval,
  PROTOCOL_VERSION,
} from "@downtrace/protocol";
import type { Logger } from "./log.ts";

export interface SenderOptions {
  url: string;
  token: string;
  agent: AgentInfo;
  instance: InstanceInfo;
  deploy: DeployInfo;
  log: Logger;
  /** Intervals kept while the cloud is unreachable; the oldest is dropped beyond this. */
  maxQueued?: number | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export const DEFAULT_MAX_QUEUED = 6;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Ships intervals to the cloud in batches. Never blocks, never grows without
 * bound: failed batches stay queued (up to maxQueued) and ride the next flush.
 */
export class Sender {
  private queue: Interval[] = [];
  private inflight = false;
  private warnedAuth = false;
  sent = 0;
  failed = 0;
  dropped = 0;
  private readonly opts: SenderOptions;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SenderOptions) {
    this.opts = opts;
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(interval: Interval): void {
    this.queue.push(interval);
    while (this.queue.length > this.maxQueued) {
      this.queue.shift();
      this.dropped += 1;
    }
  }

  /** Sends everything queued in one batch. Resolves true when the cloud accepted it. */
  async flush(timeoutMs = this.timeoutMs): Promise<boolean> {
    if (this.inflight || this.queue.length === 0) return false;
    this.inflight = true;
    const intervals = this.queue.slice(0, this.maxQueued);
    const batch: AggregatesBatch = {
      protocol: PROTOCOL_VERSION,
      agent: this.opts.agent,
      instance: this.opts.instance,
      deploy: this.opts.deploy,
      // 1..maxQueued intervals by construction; the generated type is a union of tuples.
      intervals: intervals as AggregatesBatch["intervals"],
    };
    try {
      const res = await this.fetchImpl(`${this.opts.url}${AGGREGATES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        this.queue = this.queue.filter((iv) => !intervals.includes(iv));
        this.sent += 1;
        this.opts.log.debug(`sent ${intervals.length} interval(s)`);
        return true;
      }
      this.failed += 1;
      if (res.status === 401 && !this.warnedAuth) {
        this.warnedAuth = true;
        this.opts.log.warn("the cloud rejected DOWNTRACE_TOKEN (401); aggregates will be dropped until it is fixed");
      } else {
        this.opts.log.debug(`cloud responded ${res.status}; keeping ${this.queue.length} interval(s) queued`);
      }
      return false;
    } catch (err) {
      this.failed += 1;
      this.opts.log.debug(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.inflight = false;
    }
  }
}
