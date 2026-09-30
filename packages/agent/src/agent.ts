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
import { Captures, type LiveCapture, type PrearmReserve, sliceFor } from "./captures.ts";
import { CoarseRegister } from "./coarse.ts";
import type { AgentConfig } from "./config.ts";
import {
  currentContext,
  type DependencyWork,
  enterRequest,
  type OperationKind,
  poolWaitOf,
  type RequestContext,
  recordOperationIn,
} from "./context.ts";
import { ErrorFingerprintCache, errorFingerprint } from "./errors.ts";
import { FRAMEWORK, ProcessExceptions, UNCAUGHT, UNHANDLED_REJECTION } from "./exceptions.ts";
import { Excluded } from "./exclude.ts";
import { FineRegister } from "./fine.ts";
import { type Fingerprint, FingerprintCache } from "./fingerprint.ts";
import { createInspector } from "./inspect.ts";
import { instrumentHttp } from "./instrument/http.ts";
import { armPg, instrumentPg } from "./instrument/pg.ts";
import { instrumentRedis } from "./instrument/redis.ts";
import { createLogger, type Logger } from "./log.ts";
import { withheldName } from "./minimal.ts";
import { OverheadMeter, Sheddable, type SheddableLevel, shedReasonOf } from "./overhead.ts";
import { PrearmRegister } from "./prearm.ts";
import { ProfileAggregator } from "./profile.ts";
import { ReferenceRegister } from "./reference.ts";
import { clientError, sanitizeContext } from "./report.ts";
import { normalizeMethod, routeOf } from "./routes.ts";
import { RuntimeSampler } from "./runtime.ts";
import { Sender } from "./transport.ts";
import { ARM_FOR_MS, LocalTriggers } from "./trigger.ts";
import { AGENT_VERSION } from "./version.ts";

const REQUEST_START = "http.server.request.start";
const RESPONSE_FINISH = "http.server.response.finish";
const MAX_INTERNAL_ERRORS = 10;
const SHUTDOWN_FLUSH_MS = 1_000;
const SIGNALS = ["SIGTERM", "SIGINT"] as const;
/**
 * When this process started, in the clock the rest of the world reads. `performance.now()` measures
 * durations and never jumps; adding this to one turns it into the instant it happened, which is what an
 * instant in the evidence has to be (gh-399).
 */
const EPOCH = performance.timeOrigin;

/**
 * The clock in production. `EPOCH + performance.now()` and not `Date.now()`: it is the one the fine register
 * already dates requests with, and an instant that is compared with those has to come from the same place.
 */
const defaultNow = () => EPOCH + performance.now();

export interface AgentDeps {
  /** The coarse register, so a test can drive its clock. */
  coarse?: CoarseRegister;
  /** The fine register, so a test can size its rings down to a few entries. */
  fine?: FineRegister;
  /** The reference samples, so a test can make them small or make their selection deterministic. */
  reference?: ReferenceRegister;
  /**
   * The prearmed reserve, so a test can arm a route and read what the agent put in it.
   *
   * It was the one register without this seam, and that is part of why nothing noticed that the agent fed it
   * empty rows and never read them back: every piece had a test and the wiring had none (gh-498).
   */
  prearm?: PrearmRegister;
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
  /**
   * The clock every **instant** this agent produces comes from, so a test can place one exactly.
   *
   * Absolute, in milliseconds, and derived from `performance` rather than from `Date`: durations are measured
   * with `performance.now()`, which counts from the start of the process and is the only one that cannot jump,
   * and an instant has to be absolute or two instances cannot be read side by side (ADR 0107, gh-399).
   *
   * One and not two. A capture's start used to be read with `Date.now()` while the requests it is compared
   * against were dated with this one; the two agree when the process starts and drift apart afterwards, so
   * inside a millisecond there was no order between them — and a request that happened during a capture was
   * counted as one from before it (gh-538).
   */
  now?: () => number;
  /**
   * The cadence of the tick that feeds the coarse register's event loop series, in milliseconds. A second in
   * production, which is the granularity the series has: one slot per second (ADR 0067). A test shortens it so
   * the wiring is exercised without waiting for the production cadence.
   */
  loopTickMs?: number;
}

export interface AgentStats {
  recorded: number;
  internalErrors: number;
  disabled: boolean;
  /**
   * What the instrumentation has given up because it was costing too much, and why. `product.md:241` asks
   * for both: «it throttles itself» and «records it as a loss of coverage» (gh-271).
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
  request?: { method?: string; url?: string; route?: unknown; baseUrl?: unknown; originalUrl?: unknown };
  response?: { statusCode?: number };
}

/**
 * An error somebody handed the instrumentation rather than one it observed (ERR-02).
 *
 * A parameter object, because the three are not interchangeable and two of them are `unknown`: positional
 * arguments here would be a call nobody can read at the call site.
 */
export interface ReportedError {
  /** Whatever was thrown. `unknown` until `errorFingerprint` decides what can be said about it. */
  error: unknown;
  /** Whatever the application passed as a context, validated and sanitised before anything is done with it. */
  context?: unknown;
  /** `explicit` when the application reported it, `framework` when its error path did. */
  kind: Extract<OperationKind, "framework" | "explicit">;
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
  /** Every instant this agent produces. See `AgentDeps.now`: one clock, not two (gh-538). */
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly recorder: Recorder;
  /** The coarse half of the black box: the last few minutes, second by second. */
  private readonly coarse: CoarseRegister;
  /** The fine half: the last tens of seconds, request by request and operation by operation. */
  private readonly fine: FineRegister;
  /** A few requests per endpoint, kept as something for a capture to compare against (gh-307). */
  private readonly reference: ReferenceRegister;
  /** Empty unless a route is armed, which nothing does yet (gh-476). */
  private readonly prearm: PrearmRegister;
  /** The local signals that ask for a capture when the process is in trouble (gh-409). */
  private readonly triggers = new LocalTriggers();
  /**
   * How many internal errors have already been said — carried by a batch that **landed** — so each is counted
   * once (gh-243, gh-724).
   */
  private reportedInternalErrors = 0;
  private readonly sender: Sender;
  private readonly handleSignals: boolean;
  /** The cadence of the event loop feed, from the deps; a second by default (see `AgentDeps.loopTickMs`). */
  private readonly loopTickMs: number | undefined;
  private readonly starts = new WeakMap<object, number>();
  private readonly contexts = new WeakMap<object, RequestContext>();
  private readonly runtime: RuntimeSampler;
  /** What the instrumentation costs, measured while it runs, and what it gives up when it costs too much. */
  private readonly overhead: OverheadMeter;
  /** Only when Postgres is instrumented: without it no query text is ever looked at. */
  private readonly fingerprints: FingerprintCache | undefined;
  /** Where a thrown thing becomes an identity rather than a tally (gh-338). */
  private readonly errors: ErrorFingerprintCache;
  private readonly profile: ProfileAggregator;
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
      this.exceptions.record(origin === "unhandledRejection" ? UNHANDLED_REJECTION : UNCAUGHT, err, {
        // In minimal mode the signature keeps its identity and loses its words: the hash is a digest and
        // says nothing, and the text is the user's (ADR 0105).
        sign: this.signature(),
      }),
    );
  /** What the operator asked not to be looked at (`product.md:104`, ADR 0101). */
  private readonly excludedEndpoints: Excluded;
  private readonly excludedDependencies: Excluded;
  private instrumented = false;
  /**
   * The `pg` observer's deferred attach (ADR 0209): it patches the driver the application has loaded, from
   * the start of the first request at which the driver is in the module cache. Set in `start()` when `pg` is
   * asked for and no module was handed over, and cleared once the attach settles.
   */
  private pgAttach: (() => boolean) | undefined;
  private stopHttp: (() => void) | undefined;
  private stopRedis: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** The tick that feeds the coarse register's event loop series, one reading a second (gh-629). */
  private loopTimer: NodeJS.Timeout | undefined;
  private started = false;
  private recorded = 0;
  private internalErrors = 0;
  private disabled = false;
  private readonly onStart = (message: unknown): void => this.guard(() => this.requestStarted(message));
  private readonly onFinish = (message: unknown): void => this.guard(() => this.responseFinished(message));
  private readonly onSignal: Record<(typeof SIGNALS)[number], () => void>;
  /**
   * Every flush under way: the interval timer's, a signal's, `stop()`'s. The way out lets them finish before it
   * takes what it sends (gh-657). Each is bounded by its requests' timeouts and leaves the set when it settles, so
   * the set is bounded too.
   */
  private readonly flushing = new Set<Promise<boolean>>();
  /**
   * The drain `stop()` is under way, for a second call to wait for instead of resolving over it: the second
   * caller is the one about to `process.exit()`, and a promise that settles in the instant cuts the first
   * drain's last batch with the process (gh-690). Cleared when it settles, so a finished drain holds nothing.
   */
  private stopping: Promise<void> | undefined;
  private readonly onBeforeExit = (): void => {
    void this.flush(SHUTDOWN_FLUSH_MS, true);
  };

  constructor(config: AgentConfig, deps: AgentDeps = {}) {
    this.config = config;
    this.pgModule = deps.pgModule;
    this.now = deps.now ?? defaultNow;
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
    // Every component that keeps a clock is handed this one, and none has a default of its own. Each used to fall
    // back to `Date.now` and this constructor passed a clock to none of them, so the interval, the profile, the
    // coarse register and the sender read the wall clock while ADR 0131 said nothing did (gh-610).
    this.recorder = deps.recorder ?? new IntervalAggregator({ now: this.now });
    // The coarse half of the black box. Always on: `product.md` says the instrumentation **maintains** it, and
    // it is cheap enough to — five additions per request into a preallocated row. It leaves with a capture,
    // which is the reading it was built for: `product.md:122` freezes it with the fine detail, and
    // `product.md:94` says why it exists (gh-629).
    this.coarse = deps.coarse ?? new CoarseRegister({ now: this.now });
    this.fine = deps.fine ?? new FineRegister();
    this.reference = deps.reference ?? new ReferenceRegister();
    this.prearm = deps.prearm ?? new PrearmRegister();
    this.runtime = deps.runtime ?? new RuntimeSampler();
    this.overhead = deps.overhead ?? new OverheadMeter({ floor: config.shed });
    // The fingerprint cache of queries exists only with Postgres instrumented **at full depth**: without it no
    // query text is ever looked at, and a bench that weighs the observer below the text (gh-592) pays none of
    // its cost. The **errors** and the profile exist always, since ERR-02: an application can report an
    // error it handled whatever else is being observed, and a profile that nothing writes into is an empty
    // map that rotates to null. Before this, a process with `DOWNTRACE_INSTRUMENT=http` had nowhere to put a
    // reported error, and the cost of always having them is two empty maps and no work on the hot path.
    if (config.instrument.has("pg") && config.pgDepth === "full") this.fingerprints = new FingerprintCache();
    this.errors = new ErrorFingerprintCache();
    // Minimal mode is the stronger of the two: `DOWNTRACE_QUERY_TEXT=off` stays as the finer control —
    // «send my routes but not my queries» is a real thing to want — and this turns it off as well. The
    // context of a reported error is not a query, so only the minimal mode withholds it (ADR 0105).
    this.profile = new ProfileAggregator({
      now: this.now,
      sendText: config.queryText && !config.minimal,
      sendContext: !config.minimal,
      windowMs: config.profileMs,
    });
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
        now: this.now,
        // What the sender cannot know about itself: the memory the registers hold, what the hooks cost,
        // and what has been given up to stay inside the budget (gh-243).
        resources: () => this.ownResources(),
        // Its `internalErrors` is said when the batch that carried it lands, and only then, so a batch that
        // failed or was refused says them again (gh-724).
        resourcesLanded: (declared) => {
          if (declared?.internalErrors !== undefined) this.reportedInternalErrors += declared.internalErrors;
        },
        inspector: createInspector(config.inspect, this.log),
      });
    this.handleSignals = deps.handleSignals ?? false;
    this.loopTickMs = deps.loopTickMs;
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

  /**
   * Records an error somebody handed over: the application itself (`captureException`) or the framework's
   * error path (`expressErrorHandler`). ERR-02.
   *
   * It goes through `guard` like every hook, which is what makes it safe: a bug here is counted as an
   * internal error of the instrumentation and never reaches the application, which is invariant 2 in the one
   * place where the application is the caller. And the error's identity is the one everything else uses, from
   * the same bounded cache: the same throw seen twice is one signature.
   *
   * Where it lands is decided by whether a request is being served. Inside one it is an operation of the
   * profile, under the route it happened on, so the error carries its `where`; outside one it is what the
   * process saw, with no route — the same split ADR 0102 made, for the same reason.
   *
   * A `framework` error that declares itself a client's is not recorded: a 404 is an answer and not a failure.
   * An `explicit` one is, because asking for it is what `captureException` is for.
   */
  report(reported: ReportedError): void {
    // An instrumentation that was never started, has stopped, or disabled itself after its tenth internal
    // error records nothing. Checked before the guard so that a report to a dead agent costs one comparison.
    if (!this.started) return;
    this.guard(() => {
      // Here and not in the middleware: reading `status` runs the application's getters, and what they throw
      // is counted in this guard instead of reaching the application's error handler as its error (gh-664).
      if (reported.kind === FRAMEWORK && clientError(reported.error)) return;
      const sanitised = this.config.minimal ? undefined : sanitizeContext(reported.context);
      const fingerprint = this.signatureOf(reported.error);
      const ctx = currentContext();
      if (!ctx) {
        this.exceptions.record(reported.kind, reported.error, { sign: this.signature(), context: sanitised });
        return;
      }
      const at = performance.now();
      recordOperationIn(ctx, {
        kind: reported.kind,
        fingerprint,
        // An instant and not a duration: nothing was measured, because the application had already handled
        // this by the time it said so. The black box keeps the point in the request where it was reported,
        // which is what an order of events is for (ATR-01).
        startedAt: at,
        endedAt: at,
        failed: true,
        context: sanitised,
      });
    });
  }

  /**
   * How a signature is computed here: the text as it is, or the identity with its words removed in minimal
   * mode. One place, because a second copy of this decision is a second answer to «what leaves the server».
   */
  private signature(): (e: unknown) => Fingerprint {
    return this.config.minimal ? (e) => ({ ...errorFingerprint(e), text: "" }) : errorFingerprint;
  }

  /** The same, through the cache, so a throw that repeats is signed once (gh-368). */
  private signatureOf(err: unknown): Fingerprint {
    const signed = this.errors.get(err);
    return this.config.minimal ? { ...signed, text: "" } : signed;
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
    // A failure while an observer records is one of the instrumentation's own, and is counted like any other:
    // at the tenth the instrumentation disables itself (invariant 2, ADR 0161).
    const internalError = (err: unknown): void => this.internalError(err);
    // The pg observer announces itself, and knows the version: saying it again here made the log claim two
    // instrumentations where there was one, which is a false trail for whoever reads it at three in the morning.
    if (on.has("pg")) {
      if (this.pgModule !== undefined) {
        const version = instrumentPg({
          log: this.log,
          internalError,
          fingerprints: this.fingerprints,
          errors: this.errors,
          moduleImpl: this.pgModule,
          depth: this.config.pgDepth,
        });
        observers.pg = version === undefined ? "unavailable" : "on";
      } else {
        // The production path (ADR 0209): resolve without loading, and patch from the start of the first
        // request at which the application has loaded the driver. A tracker loaded beside this observer
        // instruments pg by hooking module loading, and a driver this observer loaded at start-up is one its
        // hook never sees — or sees a second time, on top of this observer's own wrapper.
        const armed = armPg({
          log: this.log,
          internalError,
          fingerprints: this.fingerprints,
          errors: this.errors,
          depth: this.config.pgDepth,
        });
        // The only observer that resolves a module, so the only one that can be asked for and not attach.
        observers.pg = armed.state;
        this.pgAttach = armed.attach;
      }
    }
    // Outgoing HTTP needs no driver: `fetch` and the node:http client publish on diagnostics_channel.
    if (on.has("http")) {
      this.stopHttp = instrumentHttp({ log: this.log, internalError, errors: this.errors });
      observers.http = "on";
    }
    if (on.has("redis")) {
      this.stopRedis = instrumentRedis({ log: this.log, internalError, errors: this.errors });
      observers.redis = "on";
    }
    // A request context is only worth opening if something is going to record into it.
    this.instrumented = on.has("pg") || on.has("http") || on.has("redis");
    // Self-observation, not instrumentation of the application: Node's own histogram and performance observer.
    if (on.has("runtime")) {
      this.runtime.start();
      observers.runtime = "on";
      // The coarse register's event loop series is fed from this one, once a second and not on the flush's
      // cadence: the series has one slot per second (ADR 0067), and a ten-second reading stamped on one of
      // them would say a second stalled that did not. Off when the runtime observer is off, because then
      // nobody samples the loop, and an unsampled second must stay absent rather than read as idle (gh-629).
      this.loopTimer = setInterval(() => this.guard(() => this.loopTick()), this.loopTickMs ?? 1_000);
      this.loopTimer.unref();
    }
    this.agentInfo.observers = observers;
    // The other half of the control channel: the orders come back in the answer to a batch (ADR 0071), and
    // until now nobody was listening. Every instance obeys — none can know what the others are doing — and
    // the cloud settles the race with a `409` on the second evidence (gh-379).
    this.sender.onCaptures = (pending) =>
      this.guard(() => {
        // The shed reading and the start are sealed together: both are this capture's beginning, and the
        // evidence later subtracts it from the reading it takes at the end (ADR 0210).
        this.captures.accept(pending, this.now(), this.overhead.shedMs());
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

  /**
   * Unsubscribes and stops timers; attempts a last flush. Idempotent, and a second call while the first is
   * still draining waits for the same drain instead of resolving over it (gh-690).
   */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    if (!this.started) return Promise.resolve();
    this.started = false;
    process.removeListener("uncaughtExceptionMonitor", this.onThrown);
    diagnostics_channel.unsubscribe(REQUEST_START, this.onStart);
    diagnostics_channel.unsubscribe(RESPONSE_FINISH, this.onFinish);
    if (this.timer) clearInterval(this.timer);
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = undefined;
    this.stopHttp?.();
    this.stopHttp = undefined;
    this.stopRedis?.();
    this.stopRedis = undefined;
    this.runtime.stop();
    process.removeListener("beforeExit", this.onBeforeExit);
    for (const s of SIGNALS) process.removeListener(s, this.onSignal[s]);
    const stopping: Promise<void> = this.flush(SHUTDOWN_FLUSH_MS, true).then(() => undefined);
    this.stopping = stopping;
    const forget = (): void => {
      this.stopping = undefined;
    };
    stopping.then(forget, forget);
    return stopping;
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
   *
   * **And on the way out `timeoutMs` is one deadline for all of it**, started here: the batch and every
   * capture's evidence share it. Each request used to start a clock of its own, one after another, so a cloud
   * that took the connection and never answered held a leaving process one second for the batch and five for
   * each capture under way — 21 s with four, against a limit that said one (gh-650). Otherwise it bounds the
   * batch, and each evidence has the sender's own default: nothing waits on a flush that is not leaving.
   *
   * **And the way out starts by letting every flush already under way finish**, within the same deadline. The
   * sender has one batch in flight at a time and says `false` to a second, so a way out that found the interval's
   * batch in flight sent nothing of its own, and the last interval left with the process (gh-657). A flush that
   * is not leaving still waits for nothing: one per interval, each waiting behind a slow cloud, would pile up.
   */
  private flush(timeoutMs: number | undefined, leaving: boolean): Promise<boolean> {
    // Read before this one joins them: the way out waits for what was already under way, never for itself.
    const underWay = leaving ? [...this.flushing] : [];
    const flushing = this.flushOnce(timeoutMs, leaving, underWay);
    this.flushing.add(flushing);
    const forget = (): void => {
      this.flushing.delete(flushing);
    };
    flushing.then(forget, forget);
    return flushing;
  }

  private async flushOnce(
    timeoutMs: number | undefined,
    leaving: boolean,
    underWay: Promise<boolean>[],
  ): Promise<boolean> {
    const deadline = leaving ? AbortSignal.timeout(timeoutMs ?? SHUTDOWN_FLUSH_MS) : undefined;
    try {
      // Before anything is taken, and not after: the batch in flight clears, when it lands, the capture reports the
      // sender holds —they are replaced and not accumulated, and the next flush would hand them over again— and a
      // process that is leaving has no next flush. The exceptions and the asks are no longer at stake: a landing
      // takes off only what it carried (gh-626). The flushes under way are not cut when the deadline passes; each
      // keeps its own timeout.
      if (deadline) await settledWithin(underWay, deadline);
      // A profile covers a whole minute, so it rotates on its own cadence and rides whichever flush comes next.
      const profile = leaving ? this.profile.drain() : this.profile.rotate();
      if (profile) this.sender.enqueueProfile(profile);
      // What the cloud asked for and this process really started, said once (ADR 0098).
      this.sender.enqueueCaptures(this.captures.toReport());
      // What died outside a request. Taken rather than copied: a batch that lands has said them, and one
      // that does not gets them back (ADR 0103). The occurrences the register's own cap did not admit ride
      // with the ones it did admit, so the loss is said by the same batch that says the rest (gh-659).
      this.sender.enqueueExceptions({ exceptions: this.exceptions.take(), dropped: this.exceptions.takeDropped() });
      this.declareWithholding();
      const interval = this.recorder.rotate();
      if (interval) {
        // Only alongside traffic: an interval with no requests has nothing to correlate the process with.
        const runtime = this.runtime.rotate();
        this.sender.enqueue(runtime ? { ...interval, runtime } : interval);
        // The same reading the batch carries, read once more by the side that can act on it. A process
        // whose event loop is running late knows it long before any aggregate crosses the network, and by
        // the time the cloud could notice, the detail that would explain it is overwritten (gh-409).
        const ask = this.triggers.interval(runtime, this.now());
        if (ask) this.sender.enqueueTriggers([ask]);
        // And the routes whose requests keep queueing for a connection get armed, which asks the cloud for
        // nothing: it only keeps their detail out of reach of everyone else's traffic until the arm expires
        // (ADR 0122). Read from the interval that was just built, so it costs nothing per request.
        for (const label of this.triggers.endpoints(interval, this.now())) {
          this.prearm.arm(label, this.now(), ARM_FOR_MS);
        }
      }
      const sent = await this.sender.flush(deadline ?? timeoutMs);
      // Said, because it is the last thing this process will say about it: nothing is queued in a process that
      // is leaving, and there is no next batch to count the loss in (gh-650).
      if (!sent && deadline?.aborted) {
        this.log.debug(`leaving: the last batch did not land within ${SHUTDOWN_FLUSH_MS} ms and is dropped`);
      }
      // Evidence after the batch and not with it: it goes on its own path, for its own size (ADR 0073).
      // Leaving hands over everything under way, because partial evidence is an answer and silence is not —
      // for as long as the deadline lasts, and not a request longer.
      await this.deliverEvidence(leaving ? this.captures.takeAll() : this.captures.take(this.now()), deadline);
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
   * A capture that saw nothing sends **empty** evidence and not silence: «a capture with no requests does not prove
   * recovery» (CAP-01), and the cloud already knows how to answer that. Failures are logged and
   * dropped — a `409` is another instance having been quicker, and nothing here is worth retrying after its
   * window has closed (gh-379).
   *
   * On the way out they share the deadline the batch had. Once it has passed nothing more is built or sent: the
   * request in flight is cut, the rest are dropped, and how many captures went without their evidence is said.
   * The cloud sees those captures expire, which is what accepting one never promised otherwise (CAP-01, gh-650).
   */
  private async deliverEvidence(done: LiveCapture[], deadline?: AbortSignal): Promise<void> {
    let without = 0;
    for (const capture of done) {
      if (deadline?.aborted) {
        without += 1;
        continue;
      }
      // With the reserve, which is the whole point of having one: a route armed before this capture kept its
      // requests out of reach of everyone else's traffic, and this is where the two registers meet (ADR 0122).
      // A capture of a route reads that route's reserve, and a capture without a route reads every armed
      // route's, each from its own arm. The argument used to be a single route or nothing, and a capture of a
      // dependency has no route to name: it arrived at no reserve at all and delivered only what the global
      // ring happened to still hold (gh-498, and the last cut half of it, gh-861).
      const route = capture.footprint.route;
      const now = this.now();
      let prearm: PrearmReserve[];
      if (route !== undefined && route !== "") {
        // The order carries the name the cloud knows — the outside name — and that is what the arm is keyed
        // on. A `nameOf` here would withhold a name that already left withheld, and the reserve of an armed
        // route would never be found (gh-860).
        const own = this.prearm.reserveFor(capture.footprint.method ?? "", route, now);
        prearm = own === null ? [] : [own];
      } else {
        prearm = this.prearm.armedReserves(now);
      }
      const slice = sliceFor(capture, this.fine.snapshot(), (route) => this.nameOf(route), prearm);
      // The shedding inside this window: the meter's reading now minus the one sealed at the capture's
      // start, both on the meter's own clock, so nothing compares an instant across clocks (ADR 0131).
      // Rounded up: a fraction of a millisecond of shedding is still shedding, and an `ms` of 0 would be
      // refused by the contract anyway (ADR 0210).
      const shedMs = Math.ceil(this.overhead.shedMs() - capture.shedMs);
      const shedReason = shedMs > 0 ? this.overhead.lastShedReason() : undefined;
      const evidence: CaptureEvidence = {
        protocol: PROTOCOL_VERSION,
        instance: { id: this.instance.id },
        startedAt: new Date(capture.startedAt).toISOString(),
        endedAt: new Date(this.now()).toISOString(),
        coverage: {
          observedRequests: slice.observedRequests,
          attachedRequests: slice.attachedRequests,
          detailLost: slice.detailLost,
          truncated: slice.truncated,
          // Present only when the meter itself decided the shedding inside this window: absent means «the
          // evidence does not say» — no shedding, the configuration's floor, or a sender older than the
          // field (ADR 0210).
          ...(shedMs > 0 && shedReason !== undefined ? { shed: { ms: shedMs, reason: shedReason } } : {}),
        },
        reference: this.referenceFor(),
        coarse: this.coarseFor(),
        requests: slice.requests.map((r) => ({
          method: r.method,
          // The register keeps the real template —the black box never leaves the process— and this is the
          // moment it does (ADR 0105).
          route: this.nameOf(r.route),
          status: r.status,
          startedAt: new Date(r.startedAt).toISOString(),
          durationMs: r.durationMs,
          // Omitted when the request asked no pool, which the contract reads as «this one did not queue» and
          // not as «it queued for nothing» (gh-471).
          ...(r.poolWaitMs === undefined ? {} : { poolWaitMs: r.poolWaitMs }),
          operations: r.operations.map((o) => ({ hash: o.hash, startMs: o.startMs, endMs: o.endMs })),
          // On the request and not only in the totals, because an empty list without a mark reads as a
          // request that ran nothing (invariant 14). Omitted when false: the contract says absent means
          // false, and sending it on every request would pay for the normal case to say nothing (gh-396).
          ...(r.detailLost ? { detailLost: true } : {}),
          ...(r.truncated ? { truncated: true } : {}),
        })),
      };
      const delivered = await this.sender.sendEvidence(capture.id, evidence, deadline);
      if (!delivered && deadline?.aborted) without += 1;
    }
    if (without > 0) {
      this.log.debug(
        `leaving: ${without} capture(s) left without their evidence: the cloud did not take it within ${SHUTDOWN_FLUSH_MS} ms`,
      );
    }
  }

  /**
   * The samples a capture carries, with how they were chosen.
   *
   * `product.md:100`: «Every sample identifies its reference and how it was selected; being earlier does not certify
   * health». The second half is the cloud's to say; the first is this (gh-307).
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
   * The coarse summary a capture carries: the last few minutes, second by second.
   *
   * `product.md:122`: a capture freezes «the coarse summary of the previous minutes» and sends it, and
   * `product.md:94` is why the register exists — «makes it possible to see how something detected late began».
   * The snapshot is the freeze: a watched quiet second is a zero, an unwatched one is absent, and the event
   * loop stays in its own series (ADR 0067). Sent whole and not filtered by the capture's footprint, because
   * the summary is the process's — what the other routes were doing is exactly the context the captured one
   * needs — and it is bounded by the register's own caps, which the contract pins (gh-629).
   */
  private coarseFor(): NonNullable<CaptureEvidence["coarse"]> {
    const snapshot = this.coarse.snapshot();
    return {
      windowSeconds: snapshot.coverage.windowSeconds,
      routesDropped: snapshot.coverage.routesDropped,
      routes: snapshot.routes.map((r) => ({
        method: r.method,
        // The register keeps the real template, like the fine register does; this is the moment it is named
        // for the outside (ADR 0105).
        route: this.nameOf(r.route),
        seconds: r.seconds,
      })),
      eventLoop: snapshot.eventLoop,
    };
  }

  /**
   * One tick of the event loop feed: a reading into the coarse register's series, or nothing.
   *
   * The tick runs where a bug must not reach the application (invariant 2), so it goes through the guard, and
   * a reading the sampler has none of is left absent: a second with no sample says nothing about the loop,
   * and a zero would say it was idle (ADR 0067, gh-629).
   */
  private loopTick(): void {
    const ms = this.runtime.secondDelayMs();
    if (ms !== undefined) this.coarse.recordEventLoop(ms);
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
   * `product.md:239` asks for it by name —«measured internal resources»— and the reason it matters is one
   * distinction: a cloud that sees nothing has to be able to tell «nothing happened» from «this
   * instrumentation has been throwing batches away» (invariant 14).
   *
   * Only what is worth saying: a field that would be zero is left out, because absent means «did not
   * say» and zero would be a claim (the rule the observers set, ADR 0093).
   */
  private ownResources(): AgentResources | undefined {
    const overhead = this.overhead.state();
    const out: AgentResources = {};
    // Declared, not yet said: what `reportedInternalErrors` advances by is what a batch that **lands**
    // declared, through the sender's `resourcesLanded`. Advanced here, at the build, a batch that failed or
    // was refused would have lost the number — a counter that dies with its batch lies downwards (gh-724).
    if (this.internalErrors > this.reportedInternalErrors) {
      out.internalErrors = this.internalErrors - this.reportedInternalErrors;
    }
    // The label tables the registers key by traffic are in their `bytes` (gh-765), the reserve is the
    // register that is preallocated for a route nobody has served yet (gh-805), and the decisions the
    // exclusions remember are the last thing the agent holds that traffic names.
    const bytes =
      this.fine.bytes() +
      this.coarse.bytes() +
      this.reference.bytes() +
      this.prearm.bytes() +
      this.excludedEndpoints.bytes() +
      this.excludedDependencies.bytes();
    if (bytes > 0) out.bufferBytes = bytes;
    // An estimate, sampled, and sent as one: it is what invariant 3 budgets, and calling it a
    // measurement would claim a precision the sampling does not have.
    if (overhead.perRequestMs > 0) out.hookMsPerRequest = overhead.perRequestMs;
    if (overhead.shed !== Sheddable.Nothing) {
      out.shed = overhead.shed === Sheddable.Fine ? "fine" : "profile";
      // The one place the phrase becomes the protocol's word: the evidence's `coverage.shed.reason` is
      // translated by the same function (ADR 0210).
      const reason = shedReasonOf(overhead.reason);
      if (reason !== undefined) out.shedReason = reason;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * What a route is called outside this process: itself, or a digest of itself in minimal mode.
   *
   * One place rather than three, because the name has to be the **same** in the batch, in the evidence and
   * in the comparison against what the cloud asks to capture — the cloud only ever knew the digest, and a
   * filter that compared it against the real template found nothing (gh-395).
   *
   * It is applied to the template as it was served, and only at the exit — the batch, the evidence, the
   * comparison. Never to a name that already left withheld: `withheldName` is not idempotent, and a digest
   * of a digest is a name the cloud has never seen (gh-860).
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

  /**
   * Whether the black box is holding more than it reserves, the one state in which the arithmetic of ADR 0067
   * no longer holds.
   *
   * `product.md:241`: «if it approaches its memory budget, it reduces the detail window and records it as a
   * loss of coverage». The registers' budget is their reserve, so the line moves with them: it used to be a
   * fixed line below the worst case of the two, which the coarse register crossed on its way to a cap it is
   * designed to reach — seventy-seven distinct routes on a server with scanner traffic — and the detail was
   * shed for the rest of the process's life although nothing had grown beyond its budget (gh-774).
   *
   * Each register is compared against its own reserve, and the reserve includes the label tables the traffic
   * fills (gh-765, and the reserve's and the reference's since gh-805): they are bounded by construction, so
   * what a register holds is what it reserves, and a register within its reserve does not shed. The reserve
   * is in the comparison and not only in the sum it reports, because a line that does not read it would not
   * read a growth of it either (gh-805).
   */
  private overMemoryReserve(): boolean {
    return (
      this.fine.bytes() > this.fine.reservedBytes() ||
      this.coarse.bytes() > this.coarse.reservedBytes() ||
      this.prearm.bytes() > this.prearm.reservedBytes()
    );
  }

  private requestStarted(message: unknown): void {
    const request = (message as { request?: object }).request;
    if (!request) return;
    const startedAt = performance.now();
    this.starts.set(request, startedAt);
    this.runtime.requestStarted();
    // The pg observer's deferred attach (ADR 0209): by the time a request starts the application has
    // finished loading its modules, so this is the moment the patch goes in if the driver is in the module
    // cache, and it is before the handler runs. One property read per request until the attach settles;
    // nothing after, because the reference goes with the settle.
    if (this.pgAttach?.()) this.pgAttach = undefined;
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
      const startedWall = startedAt === undefined ? this.now() - ms : EPOCH + startedAt;
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
        // Measured already, on those same entries: `pg.ts` writes the wait into this request's own context and
        // until gh-471 it died with the request. NaN when it asked no pool, which the row keeps apart from a
        // wait of zero.
        poolWaitOf(ctx?.work),
      );
      // And into the armed route's own reserve, if this route is one. Costs nothing for every other request:
      // `observe` looks up the arm and returns (ADR 0122). Routes are armed a few lines above, from the pool
      // wait of the interval just built — this comment used to say nothing armed yet, which stopped being
      // true when gh-476 landed and is how the rest of this went unnoticed (gh-498).
      this.prearm.shed(!this.overhead.keeping(Sheddable.Fine));
      this.prearm.observe({
        method,
        // The template as it was served, the same the ring keeps a few lines above: the reserve is inside
        // the black box, and the name is withheld at the exit, not here (gh-860).
        route,
        // The arm is keyed by the name the cloud knows, because that is all the signal that arms it can
        // see (gh-860).
        armRoute: named,
        status: response?.statusCode ?? 0,
        startedAt: startedWall,
        durationMs: ms,
        // The same detail the ring was just given, read back from the range this request wrote: a row with
        // no operations and no dependencies is a request with its evidence thrown away, which is the
        // opposite of what a reserve is for. They used to be empty lists here (gh-498).
        operations: this.fine.operationsAt(ctx?.fineFrom ?? 0, ctx?.fineOps ?? 0).operations,
        dependencies: ctx?.work ? [...ctx.work.keys()] : [],
        poolWaitMs: poolWaitOf(ctx?.work),
      });
      // And the same request is offered to the reference samples. The operations are read back from the
      // ring **only if it takes it**, which after the first few is one request in `seen` (gh-307).
      this.reference.consider(method, route, response?.statusCode ?? 0, startedWall, ms, () =>
        this.fine.lastOperations(),
      );
    }
    if (ctx?.operations && this.overhead.keeping(Sheddable.Profile)) {
      this.profile.record(method, named, ctx.operations.values());
    }
    this.recorded += 1;
    // Closed here and not in the hook wrapper: what invariant 3 bounds is the cost **per request**, and this
    // is where a request ends.
    this.overhead.requestFinished();
    // The registers are preallocated, so this is arithmetic rather than a measurement (ADR 0067): the detail
    // goes first only when the arithmetic no longer holds, and the loss is said as a loss of coverage, not
    // hidden.
    if (this.overMemoryReserve()) this.overhead.shedForMemory();
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

  /**
   * Where the guards end: this class's `guard`, and every observer's (ADR 0161).
   * So it may not throw, whatever it is handed, or the guard that called it is not one (gh-664).
   */
  private internalError(err: unknown): void {
    this.internalErrors += 1;
    this.log.debug(`internal error: ${described(err)}`);
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

/**
 * Resolves once every one of `these` has settled or `deadline` has passed, whichever comes first. Never rejects: a
 * flush that failed has finished all the same.
 */
async function settledWithin(these: Promise<unknown>[], deadline: AbortSignal): Promise<void> {
  // An aborted signal fires no second `abort`, so waiting for one here would wait for `these` alone.
  if (these.length === 0 || deadline.aborted) return;
  let passed = (): void => {};
  const timedOut = new Promise<void>((resolve) => {
    passed = () => resolve();
    deadline.addEventListener("abort", passed, { once: true });
  });
  await Promise.race([Promise.allSettled(these), timedOut]);
  deadline.removeEventListener("abort", passed);
}

/**
 * What a failure says of itself, for the debug line, and never a second failure.
 *
 * What reaches a guard's `catch` is whatever was thrown, and when a getter of the application's threw it —on
 * the error it handed over, on a context— it is the application's value: `String` throws on an object with no
 * prototype, `instanceof` on a revoked `Proxy`, and reading `stack` runs a getter. Any of those thrown from the
 * `catch` leaves the guard and lands in the application, as its error handler's argument or in its own `catch`
 * (gh-664). So the description is attempted and, when it cannot be made, the line says so in words. This
 * translates rather than swallows: what it replaces is a sentence for a log, and the failure it describes has
 * already been counted.
 */
function described(err: unknown): string {
  try {
    return err instanceof Error ? `${err.stack ?? err.message}` : String(err);
  } catch {
    return "(a thrown value that cannot be described)";
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
