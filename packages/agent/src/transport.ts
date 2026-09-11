import type { CaptureEvidence } from "@downtrace/protocol";
import {
  AGGREGATES_PATH,
  type AgentInfo,
  type AgentResources,
  type AggregatesBatch,
  type CaptureProgress,
  captureEvidencePath,
  type DeployInfo,
  type InstanceInfo,
  type Interval,
  type LocalTrigger,
  PROTOCOL_VERSION,
  type Profile,
} from "@downtrace/protocol";
import type { CountedException } from "./exceptions.ts";
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
  /**
   * What the rest of the instrumentation has to say about itself for the next batch: the memory its
   * registers hold, the time its hooks cost, what it has given up. The sender knows its own queue and
   * nothing else, and asking is cheaper than being told on every change (gh-243).
   */
  resources?: (() => AgentResources | undefined) | undefined;
}

/**
 * A capture the cloud is asking this instrumentation to make, as it came back in the answer.
 *
 * Read from the response body, so every field is `unknown` until checked: what arrives here has been over a
 * network and is nobody's promise. Only the fields this side acts on are kept.
 */
export interface PendingCapture {
  id: string;
  windowSeconds: number;
  /** Milliseconds since the epoch. The contract sends an RFC 3339 string; it is converted on the way in. */
  expiresAt: number;
  environment?: string;
  method?: string;
  route?: string;
  /** Dependency kind and target, when the capture is about a dependency rather than a route. */
  kind?: string;
  target?: string;
}

/**
 * The contract writes an instant as an RFC 3339 string and this side counts in milliseconds, so the
 * conversion happens here, at the boundary, once. Anything that is not a date the clock can read is an order
 * that cannot be obeyed: it has no deadline, and an order with no deadline never stops (gh-398).
 */
function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The orders in one answer, or none: a body that cannot be read is no orders, never an error (gh-379). */
export function capturesIn(body: string): PendingCapture[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = (parsed as { captures?: unknown } | null)?.captures;
  if (!Array.isArray(list)) return [];
  const out: PendingCapture[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    // `as` at the boundary and nowhere else: id, window and expiry are what this side acts on, and an order
    // missing any of them is one it cannot obey.
    if (typeof c.id !== "string" || c.id === "") continue;
    if (typeof c.windowSeconds !== "number") continue;
    const expiresAt = instant(c.expiresAt);
    if (expiresAt === undefined) continue;
    const pending: PendingCapture = { id: c.id, windowSeconds: c.windowSeconds, expiresAt };
    if (typeof c.environment === "string") pending.environment = c.environment;
    if (typeof c.method === "string") pending.method = c.method;
    if (typeof c.route === "string") pending.route = c.route;
    if (typeof c.kind === "string") pending.kind = c.kind;
    if (typeof c.target === "string") pending.target = c.target;
    out.push(pending);
  }
  return out;
}

export const DEFAULT_MAX_QUEUED = 6;
/** As many capture reports as the answer may carry orders. Bounded on both sides of the same channel. */
const MAX_CAPTURE_REPORTS = 16;
/** As many signatures as the protocol accepts in one batch. */
const MAX_EXCEPTIONS = 32;
/** As many local asks as the protocol accepts, which is one per signal there is. */
const MAX_TRIGGERS = 4;
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
  /** Capture starts waiting to ride the next batch. Cleared when it lands, so nothing is said twice. */
  private captureReports: CaptureProgress[] = [];
  /** What the process threw outside any request, waiting for a batch to carry it (ADR 0103). */
  private exceptions: CountedException[] = [];
  /** What a local signal is asking for. Accumulates until a batch carries them (gh-409). */
  private triggers: LocalTrigger[] = [];
  private inflight = false;
  private warnedAuth = false;
  sent = 0;
  failed = 0;
  dropped = 0;
  /** Batches the cloud refused as invalid. Not `failed`: nothing broke, we sent something wrong. */
  rejected = 0;
  /**
   * The same three since the **last batch that landed**, which is what travels (gh-243).
   *
   * Separate counters rather than a snapshot of the totals: they have to survive a batch that never
   * arrives —what it was going to say rides the next one— and a counter that dies with its batch lies
   * downwards, which is the direction that makes a losing instrumentation look healthy.
   */
  private since = { dropped: 0, failed: 0, rejected: 0 };
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
   * What this sender has to say about itself, for the batch about to go out. Only what is worth saying:
   * a field that would be zero is left out, because **absent means «did not say»** and zero would be a
   * claim (the rule the observers set, gh-220).
   */
  private resources(): AgentResources | undefined {
    const out: AgentResources = {};
    if (this.since.dropped > 0) out.droppedBatches = this.since.dropped;
    if (this.since.failed > 0) out.failedBatches = this.since.failed;
    if (this.since.rejected > 0) out.rejectedBatches = this.since.rejected;
    const extra = this.opts.resources?.();
    if (extra) Object.assign(out, extra);
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * Queues a profile for the next batch. A batch carries at most one, so they go out oldest first and, like
   * intervals, the oldest is dropped rather than letting an unreachable cloud grow this without bound.
   */
  /** What the process threw outside a request. Accumulates: two flushes without a send must not lose one. */
  enqueueExceptions(all: CountedException[]): void {
    for (const e of all) {
      const seen = this.exceptions.find((x) => x.kind === e.kind && x.hash === e.hash);
      if (seen) seen.count += e.count;
      else if (this.exceptions.length < MAX_EXCEPTIONS) this.exceptions.push(e);
    }
  }

  /**
   * Queues what a local signal is asking for. Accumulates like the exceptions and not like the capture
   * reports: a batch that does not land must not lose the ask, because the signal that made it may have
   * passed by the time the next one goes out (gh-409).
   */
  enqueueTriggers(asks: LocalTrigger[]): void {
    for (const ask of asks) {
      if (this.triggers.some((t) => t.signal === ask.signal)) continue;
      if (this.triggers.length < MAX_TRIGGERS) this.triggers.push(ask);
    }
  }

  /** What the next batch says about the captures under way (ADR 0098). Replaces, never accumulates. */
  enqueueCaptures(reports: CaptureProgress[]): void {
    this.captureReports = reports.slice(0, MAX_CAPTURE_REPORTS);
  }

  enqueueProfile(profile: Profile): void {
    this.profiles.push(profile);
    while (this.profiles.length > this.maxQueued) {
      this.profiles.shift();
      this.dropped += 1;
      this.since.dropped += 1;
    }
  }

  enqueue(interval: Interval): void {
    this.queue.push(interval);
    while (this.queue.length > this.maxQueued) {
      this.queue.shift();
      this.dropped += 1;
      this.since.dropped += 1;
    }
  }

  /** Sends everything queued in one batch. Resolves true when the cloud accepted it. */
  /** Called with the captures the cloud asked for, when there are any. Set by the agent. */
  onCaptures: ((pending: PendingCapture[]) => void) | undefined;

  /** Called with the capture starts a batch actually delivered, so they are not delivered twice. */
  onReported: ((ids: string[]) => void) | undefined;

  /** Reads the answer's orders. Never throws into the flush: the batch already landed. */
  private async handOverCaptures(res: Response): Promise<void> {
    try {
      const pending = capturesIn(await res.text());
      if (pending.length > 0) this.onCaptures?.(pending);
    } catch (err) {
      this.opts.log.debug(`could not read the answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Sends one capture's evidence, on its own path and with its own size (ADR 0073).
   *
   * Never queued and never retried. A capture's evidence is worth something inside its window and nothing
   * after it, and the cloud settles the race between instances by itself: the first evidence ends the
   * capture and the rest get a `409`, which is not a failure here — it is another process having been
   * quicker (gh-379).
   *
   * Returns whether the cloud took it, for the log and for the tests. Nothing upstream depends on it.
   */
  async sendEvidence(id: string, evidence: CaptureEvidence, timeoutMs = this.timeoutMs): Promise<boolean> {
    if (this.opts.url === "" || this.opts.token === "") return false;
    try {
      const res = await this.fetchImpl(`${this.opts.url}${captureEvidencePath(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify(evidence),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        this.opts.log.debug(`evidence for ${id} accepted`);
        return true;
      }
      if (res.status === 409) {
        this.opts.log.debug(`evidence for ${id} was not needed: another instance got there first`);
        return false;
      }
      this.opts.log.debug(`evidence for ${id} refused with ${res.status}`);
      return false;
    } catch (err) {
      this.opts.log.debug(`evidence for ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Whether there is anything at all to send.
   *
   * A question and not a list of cases, because the list has come up short twice: once when the profile
   * was added (gh-375) and again when the capture reports were (gh-379). Anything new that a batch can
   * carry goes here, or it will not be sent on a quiet interval.
   */
  private hasSomethingToSay(): boolean {
    return (
      this.queue.length > 0 ||
      this.profiles.length > 0 ||
      this.captureReports.length > 0 ||
      this.exceptions.length > 0 ||
      this.triggers.length > 0
    );
  }

  async flush(timeoutMs = this.timeoutMs): Promise<boolean> {
    // Something to say is an interval, a profile **or** a capture report. Asking only about the interval
    // queue meant a profile with no interval to ride on never left — at shutdown, always (gh-375) — and the
    // same trap caught the capture reports the moment they existed: a capture watching a route with no
    // traffic would have gone unreported for as long as the quiet lasted (gh-379).
    if (this.inflight || !this.hasSomethingToSay()) return false;
    // The cloud asked for time. Aggregating carries on and the queue keeps dropping its oldest past six: not
    // being able to send is no reason to stop measuring what will be sendable later (gh-205).
    if (this.now() < this.silentUntil) return false;
    this.inflight = true;
    const intervals = this.queue.slice(0, this.maxQueued);
    const profile = this.profiles[0];
    const resources = this.resources();
    const batch: AggregatesBatch = {
      protocol: PROTOCOL_VERSION,
      agent: resources ? { ...this.opts.agent, resources } : this.opts.agent,
      instance: this.opts.instance,
      deploy: this.opts.deploy,
      // 1..maxQueued intervals by construction; the generated type is a union of tuples.
      intervals: intervals as AggregatesBatch["intervals"],
      ...(profile ? { profile } : {}),
      // 1..16 by construction, like the intervals above: the generated type is a union of tuples.
      ...(this.exceptions.length > 0
        ? { exceptions: this.exceptions as NonNullable<AggregatesBatch["exceptions"]> }
        : {}),
      ...(this.captureReports.length > 0
        ? { captures: this.captureReports as NonNullable<AggregatesBatch["captures"]> }
        : {}),
      // 1..4 by construction, like the rest.
      ...(this.triggers.length > 0 ? { triggers: this.triggers as NonNullable<AggregatesBatch["triggers"]> } : {}),
    };
    const reported = this.captureReports.map((c) => c.id);
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
        // Said, so it is not said again. Only on success: a report whose batch never arrived has not been
        // heard, and the capture would look accepted-but-never-started for as long as that lasted.
        this.captureReports = [];
        this.exceptions = [];
        // Asked, so it is not asked again. Only on success, like the rest: a batch that never arrived
        // never asked, and a signal that has passed is one nobody will ever ask about (gh-409).
        this.triggers = [];
        // Said, so it is not said twice. A counter that repeated itself would read as loss that keeps
        // happening (gh-243).
        this.since = { dropped: 0, failed: 0, rejected: 0 };
        this.onReported?.(reported);
        this.opts.log.debug(`sent ${intervals.length} interval(s)`);
        // The other half of the control channel (ADR 0071): the answer carries what the cloud wants
        // captured. Read after the batch is accounted for, and never allowed to unaccount it — the batch
        // arrived, whatever the body says (gh-379).
        if (this.onCaptures) await this.handOverCaptures(res);
        return true;
      }
      if (REJECTED.has(res.status)) {
        // Thrown away, not kept: it will be just as invalid next time, and meanwhile it would keep a slot from a
        // batch that is fine.
        this.queue = this.queue.filter((iv) => !intervals.includes(iv));
        if (profile) this.profiles = this.profiles.filter((p) => p !== profile);
        this.rejected += 1;
        this.since.rejected += 1;
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
      this.since.failed += 1;
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
      this.since.failed += 1;
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
