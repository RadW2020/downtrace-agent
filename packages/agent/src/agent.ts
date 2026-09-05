import { randomUUID } from "node:crypto";
import diagnostics_channel from "node:diagnostics_channel";
import { hostname } from "node:os";
import type { AgentInfo, DeployInfo, InstanceInfo } from "@downtrace/protocol";
import { IntervalAggregator, type Recorder } from "./aggregator.ts";
import type { AgentConfig } from "./config.ts";
import { enterRequest, type RequestContext } from "./context.ts";
import { instrumentPg } from "./instrument/pg.ts";
import { createLogger, type Logger } from "./log.ts";
import { normalizeMethod, routeOf } from "./routes.ts";
import { RuntimeSampler } from "./runtime.ts";
import { Sender } from "./transport.ts";
import { AGENT_VERSION } from "./version.ts";

const REQUEST_START = "http.server.request.start";
const RESPONSE_FINISH = "http.server.response.finish";
const MAX_INTERNAL_ERRORS = 10;
const SHUTDOWN_FLUSH_MS = 1_000;
const SIGNALS = ["SIGTERM", "SIGINT"] as const;

export interface AgentDeps {
  recorder?: Recorder | undefined;
  sender?: Sender | undefined;
  log?: Logger | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Flush on SIGTERM/SIGINT. Off in tests; on when loaded via register. */
  handleSignals?: boolean | undefined;
}

export interface AgentStats {
  recorded: number;
  internalErrors: number;
  disabled: boolean;
  sent: number;
  failed: number;
  dropped: number;
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
  private readonly log: Logger;
  private readonly recorder: Recorder;
  private readonly sender: Sender;
  private readonly handleSignals: boolean;
  private readonly starts = new WeakMap<object, number>();
  private readonly contexts = new WeakMap<object, RequestContext>();
  private readonly runtime = new RuntimeSampler();
  private instrumented = false;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private recorded = 0;
  private internalErrors = 0;
  private disabled = false;
  private readonly onStart = (message: unknown): void => this.guard(() => this.requestStarted(message));
  private readonly onFinish = (message: unknown): void => this.guard(() => this.responseFinished(message));
  private readonly onSignal: Record<(typeof SIGNALS)[number], () => void>;
  private readonly onBeforeExit = (): void => {
    void this.flushNow(SHUTDOWN_FLUSH_MS);
  };

  constructor(config: AgentConfig, deps: AgentDeps = {}) {
    this.config = config;
    this.log = deps.log ?? createLogger(config.debug);
    this.instance = { id: randomUUID(), hostname: hostname() || "unknown", pid: process.pid };
    const agent: AgentInfo = {
      name: "@downtrace/agent",
      version: AGENT_VERSION,
      runtime: "node",
      runtimeVersion: process.version,
    };
    const deploy: DeployInfo = { version: config.version, environment: config.environment };
    this.recorder = deps.recorder ?? new IntervalAggregator();
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
      });
    this.handleSignals = deps.handleSignals ?? false;
    this.onSignal = {
      SIGTERM: () => this.signalled("SIGTERM"),
      SIGINT: () => this.signalled("SIGINT"),
    };
  }

  get stats(): AgentStats {
    return {
      recorded: this.recorded,
      internalErrors: this.internalErrors,
      disabled: this.disabled,
      sent: this.sender.sent,
      failed: this.sender.failed,
      dropped: this.sender.dropped,
      pending: this.sender.pending,
    };
  }

  start(): void {
    if (this.started || this.disabled) return;
    this.started = true;
    if (this.config.instrument) {
      const pg = instrumentPg({ log: this.log });
      this.instrumented = pg !== undefined;
      if (pg) this.log.debug(`instrumented pg ${pg}`);
    }
    // Self-observation, not instrumentation of the application: Node's own histogram and performance observer.
    this.runtime.start();
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
    diagnostics_channel.unsubscribe(REQUEST_START, this.onStart);
    diagnostics_channel.unsubscribe(RESPONSE_FINISH, this.onFinish);
    if (this.timer) clearInterval(this.timer);
    this.runtime.stop();
    process.removeListener("beforeExit", this.onBeforeExit);
    for (const s of SIGNALS) process.removeListener(s, this.onSignal[s]);
    await this.flushNow(SHUTDOWN_FLUSH_MS);
  }

  /** Closes the current interval and sends everything queued. */
  async flushNow(timeoutMs?: number): Promise<boolean> {
    try {
      const interval = this.recorder.rotate();
      if (interval) {
        // Only alongside traffic: an interval with no requests has nothing to correlate the process with.
        const runtime = this.runtime.rotate();
        this.sender.enqueue(runtime ? { ...interval, runtime } : interval);
      }
      return await this.sender.flush(timeoutMs);
    } catch (err) {
      this.internalError(err);
      return false;
    }
  }

  private requestStarted(message: unknown): void {
    const request = (message as { request?: object }).request;
    if (!request) return;
    this.starts.set(request, performance.now());
    this.runtime.requestStarted();
    // Node publishes this inside the request's async context, so what the handler does lands in this store.
    if (this.instrumented) this.contexts.set(request, enterRequest());
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
    this.recorder.record(normalizeMethod(request.method), routeOf(request), response?.statusCode ?? 0, ms, ctx?.work);
    this.recorded += 1;
  }

  /** Every hook runs through here: an agent bug must never reach the application. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.internalError(err);
    }
  }

  private internalError(err: unknown): void {
    this.internalErrors += 1;
    this.log.debug(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (this.internalErrors >= MAX_INTERNAL_ERRORS && !this.disabled) {
      this.disabled = true;
      this.log.warn(`agent disabled after ${this.internalErrors} internal errors; your application is unaffected`);
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
    const flush = this.flushNow(SHUTDOWN_FLUSH_MS);
    if (!onlyUs) return;
    const resume = (): void => {
      process.removeListener(signal, this.onSignal[signal]);
      process.kill(process.pid, signal);
    };
    flush.then(resume, resume);
  }
}

export function createAgent(config: AgentConfig, deps: AgentDeps = {}): Agent {
  return new Agent(config, deps);
}
