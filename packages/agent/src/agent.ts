import { randomUUID } from "node:crypto";
import diagnostics_channel from "node:diagnostics_channel";
import { hostname } from "node:os";
import {
  type AgentInfo,
  type AgentResources,
  type CaptureEvidence,
  type DeployInfo,
  type InstanceInfo,
  type Observers,
  PROTOCOL_VERSION,
} from "@downtrace/protocol";
import { IntervalAggregator, type Recorder } from "./aggregator.ts";
import { Captures, type LiveCapture, sliceFor } from "./captures.ts";
import { CoarseRegister } from "./coarse.ts";
import type { AgentConfig } from "./config.ts";
import { type DependencyWork, enterRequest, type RequestContext } from "./context.ts";
import { ErrorFingerprintCache, errorFingerprint } from "./errors.ts";
import { ProcessExceptions, UNCAUGHT, UNHANDLED_REJECTION } from "./exceptions.ts";
import { Excluded } from "./exclude.ts";
import { FineRegister } from "./fine.ts";
import { FingerprintCache } from "./fingerprint.ts";
import { createInspector } from "./inspect.ts";
import { instrumentHttp } from "./instrument/http.ts";
import { instrumentPg } from "./instrument/pg.ts";
import { instrumentRedis } from "./instrument/redis.ts";
import { createLogger, type Logger } from "./log.ts";
import { withheldName } from "./minimal.ts";
import { OverheadMeter, Sheddable, type SheddableLevel, ThrottleReasons } from "./overhead.ts";
import { ProfileAggregator } from "./profile.ts";
import { ReferenceRegister } from "./reference.ts";
import { normalizeMethod, routeOf } from "./routes.ts";
import { RuntimeSampler } from "./runtime.ts";
import { Sender } from "./transport.ts";
import { LocalTriggers } from "./trigger.ts";
import { AGENT_VERSION } from "./version.ts";

const REQUEST_START = "http.server.request.start";
const RESPONSE_FINISH = "http.server.response.finish";
const MAX_INTERNAL_ERRORS = 10;
const SHUTDOWN_FLUSH_MS = 1_000;
/**
 * When the two registers together get this close to their budgets, the detail goes first.
 *
 * `product.md:241`: «si se acerca a su presupuesto de memoria, reduce la ventana de detalle y lo registra
 * como pérdida de cobertura». Three of the sixty-four mebibytes invariant 3 allows, which is what the two
 * registers reserve between them (ADR 0067, 0068); this trips at four fifths of it.
 */
const MEMORY_HIGH_WATER_BYTES = Math.floor(3 * 1024 * 1024 * 0.8);
const SIGNALS = ["SIGTERM", "SIGINT"] as const;
/**
 * When this process started, in the clock the rest of the world reads. `performance.now()` measures
 * durations and never jumps; adding this to one turns it into the instant it happened, which is what an
 * instant in the evidence has to be (gh-399).
 */
const EPOCH = performance.timeOrigin;

export interface AgentDeps {
  /** The coarse register, so a test can drive its clock. */
  coarse?: CoarseRegister;
  /** The fine register, so a test can size its rings down to a few entries. */
  fine?: FineRegister;
  /** The reference samples, so a test can make them small or make their selection deterministic. */
  reference?: ReferenceRegister;
  /** The process's own health, so a test can drive the signal that asks for a capture. */
  runtime?: RuntimeSampler;
  /** The overhead meter, so a test can sample every call and drive its clock. */
  overhead?: OverheadMeter;
  recorder?: Recorder | undefined;
  sender?: Sender | undefined;
  log?: Logger | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Flush on SIGTERM/SIGINT. Off in tests; on when loaded via register. */
  handleSignals?: boolean | undefined;
  /** The `pg` module, so a test can hand it one that cannot be instrumented. Same seam `instrumentPg` has. */
  pgModule?: unknown;
}

export interface AgentStats {
  recorded: number;
  internalErrors: number;
  disabled: boolean;
  /**
   * What the instrumentation has given up because it was costing too much, and why. `product.md:241` asks
   * for both: «se autolimita» and «lo registra como pérdida de cobertura» (gh-271).
   */
  shed: SheddableLevel;
  shedReason: string;
  /** Estimated milliseconds of hook time per request. An estimate, sampled, and named as one. */
  overheadPerRequestMs: number;
  sent: number;
  failed: number;
  dropped: number;
  /** Batches the cloud refused as invalid. A fault of ours, not of the network (gh-205). */
  rejected: number;
  pending: number;
}

interface FinishMessage {
  request?: { method?: string; url?: string; route?: unknown; baseUrl?: unknown };
  response?: { statusCode?: number };
}

/**
 * The Downtrace Node agent, v0: observes finished HTTP requests through
 * diagnostics_channel, aggregates them per route and interval, and ships
 * batches asynchronously. Nothing here runs synchronously against the cloud,
 * nothing here can throw into the application, and memory is bounded.
 */
export class Agent {
  readonly config: AgentConfig;
  readonly instance: InstanceInfo;
  private readonly agentInfo: AgentInfo;
  private readonly pgModule: unknown;
  private readonly log: Logger;
  private readonly recorder: Recorder;
  /** The coarse half of the black box: the last few minutes, second by second. */
  private readonly coarse: CoarseRegister;
  /** The fine half: the last tens of seconds, request by request and operation by operation. */
  private readonly fine: FineRegister;
  /** A few requests per endpoint, kept as something for a capture to compare against (gh-307). */
  private readonly reference: ReferenceRegister;
  /** The local signals that ask for a capture when the process is in trouble (gh-409). */
  private readonly triggers = new LocalTriggers();
  /** How many internal errors have already been reported, so each is counted once (gh-243). */
  private reportedInternalErrors = 0;
  private readonly sender: Sender;
  private readonly handleSignals: boolean;
  private readonly starts = new WeakMap<object, number>();
  private readonly contexts = new WeakMap<object, RequestContext>();
  private readonly runtime: RuntimeSampler;
  /** What the instrumentation costs, measured while it runs, and what it gives up when it costs too much. */
  private readonly overhead: OverheadMeter;
  /** All three exist only when Postgres is instrumented: without it there is nothing to fingerprint. */
  private readonly fingerprints: FingerprintCache | undefined;
  /** Where a thrown thing becomes an identity rather than a tally (gh-338). */
  private readonly errors: ErrorFingerprintCache | undefined;
  private readonly profile: ProfileAggregator | undefined;
  /** The captures the cloud has asked this process for. Empty until one arrives (gh-379). */
  private readonly captures = new Captures();
  /** What the process threw outside any request (`product.md:77`, ADR 0103). */
  private readonly exceptions = new ProcessExceptions();
  /**
   * Watched with `uncaughtExceptionMonitor` and nothing else: a plain `uncaughtException` listener
   * **handles** the exception, and a handled exception does not kill the process — measured, exit 1 with a
   * trace becomes exit 0 with nothing. That is what invariant 2 forbids (gh-386).
   */
  private readonly onThrown = (err: unknown, origin: string): void =>
    this.guard(() =>
      this.exceptions.record(
        origin === "unhandledRejection" ? UNHANDLED_REJECTION : UNCAUGHT,
        err,
        // In minimal mode the signature keeps its identity and loses its words: the hash is a digest and
        // says nothing, and the text is the user's (ADR 0105).
        this.config.minimal ? (e) => ({ ...errorFingerprint(e), text: "" }) : undefined,
      ),
    );
  /** What the operator asked not to be looked at (`product.md:104`, ADR 0101). */
  private readonly excludedEndpoints: Excluded;
  private readonly excludedDependencies: Excluded;
  private instrumented = false;
  private stopHttp: (() => void) | undefined;
  private stopRedis: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private recorded = 0;
  private internalErrors = 0;
  private disabled = false;
  private readonly onStart = (message: unknown): void => this.guard(() => this.requestStarted(message));
  private readonly onFinish = (message: unknown): void => this.guard(() => this.responseFinished(message));
  private readonly onSignal: Record<(typeof SIGNALS)[number], () => void>;
  private readonly onBeforeExit = (): void => {
    void this.flush(SHUTDOWN_FLUSH_MS, true);
  };

  constructor(config: AgentConfig, deps: AgentDeps = {}) {
    this.config = config;
    this.pgModule = deps.pgModule;
    this.excludedEndpoints = new Excluded([...config.excludeEndpoints]);
    this.excludedDependencies = new Excluded([...config.excludeDependencies]);
    this.log = deps.log ?? createLogger(config.debug);
    // The hostname is the user's; the id is ours, generated here. In minimal mode the first travels as a
    // digest of itself, which keeps two machines apart without naming either (ADR 0105).
    const host = hostname() || "unknown";
    this.instance = {
      id: randomUUID(),
      hostname: config.minimal ? withheldName(host) : host,
      pid: process.pid,
    };
    // Mutated once, in `start()`, when the observers have actually attached. The sender reads this object at
    // flush time and the first flush is always after `start()`, so there is nothing to synchronise; building
    // it here and filling it there is what lets the batch report what happened rather than what was asked.
    const agent: AgentInfo = {
      name: "@downtrace/agent",
      version: AGENT_VERSION,
      runtime: "node",
      runtimeVersion: process.version,
    };
    this.agentInfo = agent;
    // The version is the user's, and a finding is attributed to a deploy, so it travels as a digest rather
    // than not at all. The environment is **not** withheld: the ingest token already tells the cloud which
    // one this is, so hiding it here protects nothing and would collapse the scope everything is organised
    // by (ADR 0105).
    const deploy: DeployInfo = {
      version: config.minimal ? withheldName(config.version) : config.version,
      environment: config.environment,
    };
    this.recorder = deps.recorder ?? new IntervalAggregator();
    // The coarse half of the black box. Always on: `product.md` says the instrumentation **maintains** it, and
    // it is cheap enough to — five additions per request into a preallocated row. Nothing leaves the process
    // with it until captures exist.
    this.coarse = deps.coarse ?? new CoarseRegister();
    this.fine = deps.fine ?? new FineRegister();
    this.reference = deps.reference ?? new ReferenceRegister();
    this.runtime = deps.runtime ?? new RuntimeSampler();
    this.overhead = deps.overhead ?? new OverheadMeter();
    if (config.instrument.has("pg")) {
      this.fingerprints = new FingerprintCache();
      this.errors = new ErrorFingerprintCache();
      // Minimal mode is the stronger of the two: `DOWNTRACE_QUERY_TEXT=off` stays as the finer control —
      // «send my routes but not my queries» is a real thing to want — and this turns it off as well.
      this.profile = new ProfileAggregator({ sendText: config.queryText && !config.minimal });
    }
    this.sender =
      deps.sender ??
      new Sender({
        url: config.url,
        token: config.token,
        agent,
        instance: this.instance,
        deploy,
        log: this.log,
        fetchImpl: deps.fetchImpl,
        // What the sender cannot know about itself: the memory the registers hold, what the hooks cost,
        // and what has been given up to stay inside the budget (gh-243).
        resources: () => this.ownResources(),
        inspector: createInspector(config.inspect, this.log),
      });
    this.handleSignals = deps.handleSignals ?? false;
    this.onSignal = {
      SIGTERM: () => this.signalled("SIGTERM"),
      SIGINT: () => this.signalled("SIGINT"),
    };
  }

  /** What attached, once `start()` has run. Undefined before that: nothing has been attached to report. */
  get observers(): Observers | undefined {
    return this.agentInfo.observers;
  }

  get stats(): AgentStats {
    const overhead = this.overhead.state();
    return {
      recorded: this.recorded,
      internalErrors: this.internalErrors,
      disabled: this.disabled,
      shed: overhead.shed,
      shedReason: overhead.reason,
      overheadPerRequestMs: overhead.perRequestMs,
      sent: this.sender.sent,
      failed: this.sender.failed,
      dropped: this.sender.dropped,
      rejected: this.sender.rejected,
      pending: this.sender.pending,
    };
  }

  start(): void {
    if (this.started || this.disabled) return;
    this.started = true;
    const on = this.config.instrument;
    // What is being watched, and what is not, said out loud (gh-180, COB-01). `off` is «not asked for»,
    // which is a configuration and not a fault; `unavailable` is «asked for and could not attach», which is
    // the case that used to disappear into a `log.debug` nobody reads.
    const observers: Observers = {
      pg: "off",
      http: "off",
      redis: "off",
      runtime: "off",
    };
    // instrumentPg announces itself, and knows the version: saying it again here made the log claim two
    // instrumentations where there was one, which is a false trail for whoever reads it at three in the morning.
    if (on.has("pg")) {
      const version = instrumentPg({
        log: this.log,
        fingerprints: this.fingerprints,
        errors: this.errors,
        ...(this.pgModule !== undefined ? { moduleImpl: this.pgModule } : {}),
      });
      // The only observer that resolves a module, so the only one that can be asked for and not attach.
      observers.pg = version === undefined ? "unavailable" : "on";
    }
    // Outgoing HTTP needs no driver: `fetch` and the node:http client publish on diagnostics_channel.
    if (on.has("http")) {
      this.stopHttp = instrumentHttp(this.log);
      observers.http = "on";
    }
    if (on.has("redis")) {
      this.stopRedis = instrumentRedis(this.log);
      observers.redis = "on";
    }
    // A request context is only worth opening if something is going to record into it.
    this.instrumented = on.has("pg") || on.has("http") || on.has("redis");
    // Self-observation, not instrumentation of the application: Node's own histogram and performance observer.
    if (on.has("runtime")) {
      this.runtime.start();
      observers.runtime = "on";
    }
    this.agentInfo.observers = observers;
    // The other half of the control channel: the orders come back in the answer to a batch (ADR 0071), and
    // until now nobody was listening. Every instance obeys — none can know what the others are doing — and
    // the cloud settles the race with a `409` on the second evidence (gh-379).
    this.sender.onCaptures = (pending) =>
      this.guard(() => {
        this.captures.accept(pending, Date.now());
        this.renewReference();
      });
    this.sender.onReported = (ids) => this.guard(() => this.captures.reported(ids));
    process.on("uncaughtExceptionMonitor", this.onThrown);
    diagnostics_channel.subscribe(REQUEST_START, this.onStart);
    diagnostics_channel.subscribe(RESPONSE_FINISH, this.onFinish);
    this.timer = setInterval(() => void this.flushNow(), this.config.intervalMs);
    this.timer.unref();
    process.once("beforeExit", this.onBeforeExit);
    if (this.handleSignals) for (const s of SIGNALS) process.on(s, this.onSignal[s]);
    this.log.debug(
      `started: ${this.config.url} · ${this.config.environment} · ${this.config.version} · every ${this.config.intervalMs} ms`,
    );
  }

  /** Unsubscribes and stops timers; attempts a last flush. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    process.removeListener("uncaughtExceptionMonitor", this.onThrown);
    diagnostics_channel.unsubscribe(REQUEST_START, this.onStart);
    diagnostics_channel.unsubscribe(RESPONSE_FINISH, this.onFinish);
    if (this.timer) clearInterval(this.timer);
    this.stopHttp?.();
    this.stopHttp = undefined;
    this.stopRedis?.();
    this.stopRedis = undefined;
    this.runtime.stop();
    process.removeListener("beforeExit", this.onBeforeExit);
    for (const s of SIGNALS) process.removeListener(s, this.onSignal[s]);
    await this.flush(SHUTDOWN_FLUSH_MS, true);
  }

  /** Closes the current interval and sends everything queued. */
  async flushNow(timeoutMs?: number): Promise<boolean> {
    return this.flush(timeoutMs, false);
  }

  /**
   * The same, closing the profile's window whatever the clock says.
   *
   * Only on the way out. A process that lives less than a minute used to send no profile at all — `rotate`
   * looked at the clock and shutting down did not change the clock — and so did the last incomplete minute
   * of every process (gh-371).
   */
  private async flush(timeoutMs: number | undefined, leaving: boolean): Promise<boolean> {
    try {
      // A profile covers a whole minute, so it rotates on its own cadence and rides whichever flush comes next.
      const profile = leaving ? this.profile?.drain() : this.profile?.rotate();
      if (profile) this.sender.enqueueProfile(profile);
      // What the cloud asked for and this process really started, said once (ADR 0098).
      this.sender.enqueueCaptures(this.captures.toReport());
      // What died outside a request. Taken rather than copied: a batch that lands has said them, and one
      // that does not gets them back (ADR 0103).
      this.sender.enqueueExceptions(this.exceptions.take());
      this.declareWithholding();
      const interval = this.recorder.rotate();
      if (interval) {
        // Only alongside traffic: an interval with no requests has nothing to correlate the process with.
        const runtime = this.runtime.rotate();
        this.sender.enqueue(runtime ? { ...interval, runtime } : interval);
        // The same reading the batch carries, read once more by the side that can act on it. A process
        // whose event loop is running late knows it long before any aggregate crosses the network, and by
        // the time the cloud could notice, the detail that would explain it is overwritten (gh-409).
        const ask = this.triggers.interval(runtime, Date.now());
        if (ask) this.sender.enqueueTriggers([ask]);
      }
      const sent = await this.sender.flush(timeoutMs);
      // Evidence after the batch and not with it: it goes on its own path, for its own size (ADR 0073).
      // Leaving hands over everything under way, because partial evidence is an answer and silence is not.
      await this.deliverEvidence(leaving ? this.captures.takeAll() : this.captures.take(Date.now()));
      this.renewReference();
      return sent;
    } catch (err) {
      this.internalError(err);
      return false;
    }
  }

  /**
   * Freezes what the black box holds for each capture whose window closed, and sends it.
   *
   * A capture that saw nothing sends **empty** evidence and not silence: «una captura sin requests no
   * prueba recuperación» (CAP-01), and the cloud already knows how to answer that. Failures are logged and
   * dropped — a `409` is another instance having been quicker, and nothing here is worth retrying after its
   * window has closed (gh-379).
   */
  private async deliverEvidence(done: LiveCapture[]): Promise<void> {
    for (const capture of done) {
      const slice = sliceFor(capture, this.fine.snapshot(), (route) => this.nameOf(route));
      await this.sender.sendEvidence(capture.id, {
        protocol: PROTOCOL_VERSION,
        instance: { id: this.instance.id },
        startedAt: new Date(capture.startedAt).toISOString(),
        endedAt: new Date(Date.now()).toISOString(),
        coverage: {
          observedRequests: slice.observedRequests,
          attachedRequests: slice.attachedRequests,
          detailLost: slice.detailLost,
          truncated: slice.truncated,
        },
        reference: this.referenceFor(),
        requests: slice.requests.map((r) => ({
          method: r.method,
          // The register keeps the real template —the black box never leaves the process— and this is the
          // moment it does (ADR 0105).
          route: this.nameOf(r.route),
          status: r.status,
          startedAt: new Date(r.startedAt).toISOString(),
          durationMs: r.durationMs,
          operations: r.operations.map((o) => ({ hash: o.hash, startMs: o.startMs, endMs: o.endMs })),
          // On the request and not only in the totals, because an empty list without a mark reads as a
          // request that ran nothing (invariant 14). Omitted when false: the contract says absent means
          // false, and sending it on every request would pay for the normal case to say nothing (gh-396).
          ...(r.detailLost ? { detailLost: true } : {}),
          ...(r.truncated ? { truncated: true } : {}),
        })),
      });
    }
  }

  /**
   * The samples a capture carries, with how they were chosen.
   *
   * `product.md:100`: «Cada muestra identifica su referencia y cómo se seleccionó; ser anterior no
   * acredita salud». The second half is the cloud's to say; the first is this (gh-307).
   */
  private referenceFor(): NonNullable<CaptureEvidence["reference"]> {
    const snapshot = this.reference.snapshot();
    return {
      selection: snapshot.selection,
      population: snapshot.population,
      ...(snapshot.routesDropped > 0 ? { routesDropped: snapshot.routesDropped } : {}),
      ...(snapshot.renewalPaused ? { renewalPaused: true } : {}),
      samples: snapshot.samples.map((s) => ({
        method: s.method,
        route: this.nameOf(s.route),
        status: s.status,
        startedAt: new Date(s.startedAt).toISOString(),
        durationMs: s.durationMs,
        operations: s.operations.map((o) => ({ hash: o.hash, startMs: o.startMs, endMs: o.endMs })),
        ...(s.truncated ? { truncated: true } : {}),
      })),
    };
  }

  /**
   * Stops renewing the samples while this process is watching a capture, and starts again when it is not.
   *
   * It is the closest an instrumentation can get to REF-01 —«la referencia permanece protegida mientras
   * un incidente esté abierto»— from inside the process: it cannot know whether an incident is open, but
   * it knows detail has been asked of it, which is when something is happening (gh-307).
   */
  private renewReference(): void {
    if (this.captures.size > 0) this.reference.pause();
    else this.reference.resume();
  }

  /**
   * What this instrumentation costs and what it has lost, for the next batch.
   *
   * `product.md:239` asks for it by name —«recursos internos medidos»— and the reason it matters is one
   * distinction: a cloud that sees nothing has to be able to tell «nothing happened» from «this
   * instrumentation has been throwing batches away» (invariant 14).
   *
   * Only what is worth saying: a field that would be zero is left out, because absent means «did not
   * say» and zero would be a claim (the rule the observers set, ADR 0093).
   */
  private ownResources(): AgentResources | undefined {
    const overhead = this.overhead.state();
    const out: AgentResources = {};
    if (this.internalErrors > this.reportedInternalErrors) {
      out.internalErrors = this.internalErrors - this.reportedInternalErrors;
      this.reportedInternalErrors = this.internalErrors;
    }
    const bytes = this.fine.bytes() + this.coarse.bytes() + this.reference.bytes();
    if (bytes > 0) out.bufferBytes = bytes;
    // An estimate, sampled, and sent as one: it is what invariant 3 budgets, and calling it a
    // measurement would claim a precision the sampling does not have.
    if (overhead.perRequestMs > 0) out.hookMsPerRequest = overhead.perRequestMs;
    if (overhead.shed !== Sheddable.Nothing) {
      out.shed = overhead.shed === Sheddable.Fine ? "fine" : "profile";
      if (overhead.reason === ThrottleReasons.Latency) out.shedReason = "latency";
      else if (overhead.reason === ThrottleReasons.Memory) out.shedReason = "memory";
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * What a route is called outside this process: itself, or a digest of itself in minimal mode.
   *
   * One place rather than three, because the name has to be the **same** in the batch, in the evidence and
   * in the comparison against what the cloud asks to capture — the cloud only ever knew the digest, and a
   * filter that compared it against the real template found nothing (gh-395).
   */
  private nameOf(route: string): string {
    return this.config.minimal ? withheldName(route) : route;
  }

  /**
   * Says how much is being withheld, so that less arriving reads as a choice and not as a fault (ADR 0092).
   *
   * Counts and never names — the name of an excluded endpoint is exactly what the operator asked not to
   * send — and only once something has actually been excluded: a pattern that matches nothing is not
   * missing from anything, and declaring it would have the cloud explain an absence that is not there.
   */
  private declareWithholding(): void {
    const endpoints = this.excludedEndpoints.count;
    const dependencies = this.excludedDependencies.count;
    if (!this.config.minimal && endpoints === 0 && dependencies === 0) return;
    this.agentInfo.withholding = {
      ...(this.config.minimal ? { freeText: true as const } : {}),
      ...(endpoints > 0 ? { endpoints } : {}),
      ...(dependencies > 0 ? { dependencies } : {}),
    };
  }

  private requestStarted(message: unknown): void {
    const request = (message as { request?: object }).request;
    if (!request) return;
    const startedAt = performance.now();
    this.starts.set(request, startedAt);
    this.runtime.requestStarted();
    // Node publishes this inside the request's async context, so what the handler does lands in this store.
    // The fine register goes in with it: an operation is written where it happens, and reaching for a global
    // from there would be state this repository does not keep.
    // The fine register is passed only while it is being kept: shedding it has to stop the writes, not just
    // the reads, or the expensive half goes on costing what it costs.
    const fine = this.overhead.keeping(Sheddable.Fine) ? this.fine : undefined;
    if (this.instrumented) {
      this.contexts.set(
        request,
        // The dependency exclusions travel with the request: `recordCallIn` is a free function on the hot
        // path, and reaching the agent from it would mean making the agent global (ADR 0101).
        enterRequest(
          fine,
          startedAt,
          this.excludedDependencies.configured ? this.excludedDependencies : undefined,
          this.config.minimal ? withheldName : undefined,
        ),
      );
    }
  }

  private responseFinished(message: unknown): void {
    const { request, response } = message as FinishMessage;
    if (!request) return;
    const startedAt = this.starts.get(request);
    this.starts.delete(request);
    const ms = startedAt === undefined ? 0 : performance.now() - startedAt;
    this.runtime.requestFinished();
    const ctx = this.contexts.get(request);
    this.contexts.delete(request);
    const method = normalizeMethod(request.method);
    const route = routeOf(request);
    // Excluded is **not observed**: not an aggregate, not the black box, not the profile, not even the
    // count of requests. Matched against the normalised template and not the path, because excluding
    // `/users/123` and not `/users/:id` would be an exclusion that excludes nothing (ADR 0101, gh-361).
    if (this.excludedEndpoints.has(route)) return;
    // Withheld **after** the exclusion is decided, so a pattern is matched against the real template and
    // not against a digest of it, and after the black box has its own copy: what the coarse and fine
    // registers hold never leaves the process except in a capture (ADR 0105).
    const named = this.nameOf(route);
    this.recorder.record(method, named, response?.statusCode ?? 0, ms, ctx?.work);
    this.coarse.record(method, route, response?.statusCode ?? 0, ms, callsOf(ctx?.work));
    // Recorded even with nothing instrumented: a request with no operations is still a request, and its timing
    // is still true. What it has none of is detail, and an empty list says that already.
    if (this.overhead.keeping(Sheddable.Fine)) {
      // In the clock everybody else reads. Durations are measured with `performance.now()`, which counts
      // from the start of the process and is the only one that cannot jump; an **instant** has to be
      // absolute or two instances cannot be read side by side, and the capture's own start —which comes
      // from the cloud's clock— cannot be compared with it at all (gh-399).
      const startedWall = startedAt === undefined ? Date.now() - ms : EPOCH + startedAt;
      this.fine.request(
        method,
        route,
        response?.statusCode ?? 0,
        startedWall,
        ms,
        ctx?.fineFrom ?? this.fine.openRequest(),
        ctx?.fineOps ?? 0,
        // The keys `work` is already built with: a capture of a dependency has to know which requests
        // touched it, and the register holds only fingerprints, which do not say (gh-397).
        ctx?.work?.keys(),
      );
      // And the same request is offered to the reference samples. The operations are read back from the
      // ring **only if it takes it**, which after the first few is one request in `seen` (gh-307).
      this.reference.consider(method, route, response?.statusCode ?? 0, startedWall, ms, () =>
        this.fine.lastOperations(),
      );
    }
    if (ctx?.operations && this.overhead.keeping(Sheddable.Profile)) {
      this.profile?.record(method, named, ctx.operations.values());
    }
    this.recorded += 1;
    // Closed here and not in the hook wrapper: what invariant 3 bounds is the cost **per request**, and this
    // is where a request ends.
    this.overhead.requestFinished();
    // The registers are preallocated, so this is arithmetic rather than a measurement (ADR 0067): near the
    // budget, the detail goes before anything else does.
    if (this.fine.bytes() + this.coarse.bytes() > MEMORY_HIGH_WATER_BYTES) this.overhead.shedForMemory();
  }

  /** Every hook runs through here: an agent bug must never reach the application. */
  /**
   * Every hook runs through here, which is why the measurement lives here too: one place to touch, and the
   * only one that sees all of them.
   *
   * The cost when this invocation is not being timed is an increment and a comparison. Timing every one
   * would be two `performance.now()` per hook, which is exactly the spend invariant 3 bounds — measuring
   * the overhead cannot be the overhead (ADR 0080, gh-271).
   */
  private guard(fn: () => void): void {
    const started = this.overhead.enter();
    try {
      fn();
    } catch (err) {
      this.internalError(err);
    } finally {
      this.overhead.leave(started);
    }
  }

  private internalError(err: unknown): void {
    this.internalErrors += 1;
    this.log.debug(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (this.internalErrors >= MAX_INTERNAL_ERRORS && !this.disabled) {
      this.disabled = true;
      this.log.warn(
        `instrumentation disabled after ${this.internalErrors} internal errors; your application is unaffected`,
      );
      void this.stop();
    }
  }

  /**
   * If we are the only listener, flush briefly and then let the default signal
   * behaviour happen exactly as if the agent were not installed. If the app has
   * its own handlers, flush in the background and stay out of the way.
   */
  private signalled(signal: (typeof SIGNALS)[number]): void {
    const onlyUs = process.listenerCount(signal) === 1;
    // A signal is the process leaving, so the profile's window closes with it.
    const flush = this.flush(SHUTDOWN_FLUSH_MS, true);
    if (!onlyUs) return;
    const resume = (): void => {
      process.removeListener(signal, this.onSignal[signal]);
      process.kill(process.pid, signal);
    };
    flush.then(resume, resume);
  }
}

/** How many calls a request made across every dependency. Zero when nothing was instrumented. */
function callsOf(work: Map<string, DependencyWork> | undefined): number {
  if (!work) return 0;
  let calls = 0;
  for (const w of work.values()) calls += w.calls;
  return calls;
}

export function createAgent(config: AgentConfig, deps: AgentDeps = {}): Agent {
  return new Agent(config, deps);
}
