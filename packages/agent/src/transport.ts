import {
  AGGREGATES_PATH,
  type AgentInfo,
  type AggregatesBatch,
  type DeployInfo,
  type InstanceInfo,
  type Interval,
  PROTOCOL_VERSION,
  type Profile,
} from "@downtrace/protocol";
import type { Inspector } from "./inspect.ts";
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
  /** Injected in tests so a wait of hours does not take hours. */
  now?: (() => number) | undefined;
  /** Writes every batch exactly as it would be sent. Absent means the inspection mode is off (gh-181). */
  inspector?: Inspector | undefined;
}

export const DEFAULT_MAX_QUEUED = 6;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Statuses that say "this batch is wrong", as opposed to "you are wrong" or "I am having a bad day".
 *
 * A batch the cloud refuses as invalid will be refused the same way tomorrow. Keeping it costs one of the six
 * slots — displacing batches that were fine — and one request per interval on something that cannot work.
 * `401` and `403` are deliberately not here: those are temporary, and when the operator fixes the token the
 * intervals still queued are worth having (gh-205).
 */
const REJECTED: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * The longest wait a `Retry-After` can buy, in milliseconds.
 *
 * A whole day, because that is the largest value the cloud legitimately sends: when a project's daily budget is
 * spent it answers with the seconds until the next UTC day. Capping at minutes would mean going back to fighting
 * the limiter all day, which is the problem this came to fix. The cap exists so a nonsense value cannot silence
 * the instrumentation for ever, not to disobey the cloud.
 */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Ships intervals to the cloud in batches. Never blocks, never grows without
 * bound: failed batches stay queued (up to maxQueued) and ride the next flush.
 */
export class Sender {
  private queue: Interval[] = [];
  private profiles: Profile[] = [];
  private inflight = false;
  private warnedAuth = false;
  sent = 0;
  failed = 0;
  dropped = 0;
  /** Batches the cloud refused as invalid. Not `failed`: nothing broke, we sent something wrong. */
  rejected = 0;
  private warnedRejected = false;
  /** While set, the cloud has asked for time and no request goes out until then. */
  private silentUntil = 0;
  private readonly opts: SenderOptions;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: SenderOptions) {
    this.opts = opts;
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get pending(): number {
    return this.queue.length;
  }

  /**
   * Queues a profile for the next batch. A batch carries at most one, so they go out oldest first and, like
   * intervals, the oldest is dropped rather than letting an unreachable cloud grow this without bound.
   */
  enqueueProfile(profile: Profile): void {
    this.profiles.push(profile);
    while (this.profiles.length > this.maxQueued) {
      this.profiles.shift();
      this.dropped += 1;
    }
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
    // Something to say is an interval **or** a profile. The queue is intervals, and asking only about it
    // meant a profile with no interval to ride on never left — at shutdown, always, and in any window that
    // closed with no traffic. The ADR 0017 says the profile hangs off the batch and not off an interval; its
    // delivery did not (gh-375).
    if (this.inflight || (this.queue.length === 0 && this.profiles.length === 0)) return false;
    // The cloud asked for time. Aggregating carries on and the queue keeps dropping its oldest past six: not
    // being able to send is no reason to stop measuring what will be sendable later (gh-205).
    if (this.now() < this.silentUntil) return false;
    this.inflight = true;
    const intervals = this.queue.slice(0, this.maxQueued);
    const profile = this.profiles[0];
    const batch: AggregatesBatch = {
      protocol: PROTOCOL_VERSION,
      agent: this.opts.agent,
      instance: this.opts.instance,
      deploy: this.opts.deploy,
      // 1..maxQueued intervals by construction; the generated type is a union of tuples.
      intervals: intervals as AggregatesBatch["intervals"],
      ...(profile ? { profile } : {}),
    };
    const body = JSON.stringify(batch);
    // Written before sending, and written the same whether the send succeeds or not: what the inspection mode
    // shows is what this instrumentation produced, which is the question it exists to answer (gh-181).
    await this.opts.inspector?.write(body);
    // No cloud configured: inspecting is the whole job, and there is nothing to fail at.
    if (this.opts.url === "" || this.opts.token === "") {
      this.queue = this.queue.filter((iv) => !intervals.includes(iv));
      if (profile) this.profiles = this.profiles.filter((p) => p !== profile);
      this.inflight = false;
      return true;
    }
    try {
      const res = await this.fetchImpl(`${this.opts.url}${AGGREGATES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        this.queue = this.queue.filter((iv) => !intervals.includes(iv));
        // Only on success: a profile whose batch never arrived stays queued and rides the next one.
        if (profile) this.profiles = this.profiles.filter((p) => p !== profile);
        this.sent += 1;
        this.opts.log.debug(`sent ${intervals.length} interval(s)`);
        return true;
      }
      if (REJECTED.has(res.status)) {
        // Thrown away, not kept: it will be just as invalid next time, and meanwhile it would keep a slot from a
        // batch that is fine.
        this.queue = this.queue.filter((iv) => !intervals.includes(iv));
        if (profile) this.profiles = this.profiles.filter((p) => p !== profile);
        this.rejected += 1;
        if (!this.warnedRejected) {
          this.warnedRejected = true;
          this.opts.log.warn(
            `the cloud rejected this batch as invalid (${res.status}); this instrumentation is producing ` +
              "something its cloud does not accept, and those batches are being discarded. Said once.",
          );
        }
        return false;
      }
      this.failed += 1;
      if (res.status === TOO_MANY_REQUESTS) {
        const wait = retryAfterMs(res.headers.get("retry-after"), this.now());
        if (wait !== undefined) {
          this.silentUntil = this.now() + wait;
          this.opts.log.debug(`cloud asked to wait ${Math.round(wait / 1000)} s; holding ${this.queue.length}`);
          return false;
        }
      }
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

const TOO_MANY_REQUESTS = 429;

/**
 * How long a `Retry-After` asks for, in milliseconds, or nothing when it asks for nothing usable.
 *
 * Seconds or an HTTP date, which is what the standard allows. Anything unparseable, negative or in the past is
 * treated as absent rather than guessed at: a header we cannot read is not an instruction.
 */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === "") return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
