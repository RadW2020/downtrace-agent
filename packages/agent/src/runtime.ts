import { type IntervalHistogram, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import type { RuntimeHealth } from "@downtrace/protocol";

const NS_PER_MS = 1e6;
/** How often the event loop delay is sampled. 10 ms is Node's own default and costs nothing measurable. */
const RESOLUTION_MS = 10;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Watches the agent's own process: how late the event loop runs, how much time goes to garbage collection, how
 * much memory is held and how many requests are in flight at once.
 *
 * In Node many slowdowns are neither the database nor the network but the process itself, and a diagnosis that
 * does not measure it will blame whatever it does measure. All of this comes from Node's own instruments: a
 * native histogram and a performance observer, both of which run whether we look at them or not.
 */
export class RuntimeSampler {
  private loop: IntervalHistogram | undefined;
  /** The histogram the coarse register's event loop series reads: one per-second reading out of it, and the
   * interval's percentiles stay on their own, because a per-second reading cannot be derived from a window
   * that a `rotate()` resets. */
  private loopSecond: IntervalHistogram | undefined;
  private observer: PerformanceObserver | undefined;
  private gcCount = 0;
  private gcPauseMs = 0;
  private inFlight = 0;
  private inFlightMax = 0;

  get started(): boolean {
    return this.loop !== undefined;
  }

  start(): void {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.loop.enable();
    this.loopSecond = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.loopSecond.enable();
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcCount += 1;
        this.gcPauseMs += entry.duration;
      }
    });
    this.observer.observe({ entryTypes: ["gc"] });
  }

  stop(): void {
    this.loop?.disable();
    this.loop = undefined;
    this.loopSecond?.disable();
    this.loopSecond = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /**
   * The process's event loop delay for the last second, and nothing else — or nothing at all when there was
   * no reading of it.
   *
   * This is what feeds the coarse register's event loop series (ADR 0067), second by second. The count is
   * the half that decides: a window with no sample says nothing about the loop, and a zero would say it was
   * idle, which is the one answer the series must not invent.
   */
  secondDelayMs(): number | undefined {
    if (!this.loopSecond) return undefined;
    const samples = this.loopSecond.count;
    const ms = this.loopSecond.max / NS_PER_MS;
    this.loopSecond.reset();
    return samples > 0 ? round3(ms) : undefined;
  }

  requestStarted(): void {
    this.inFlight += 1;
    if (this.inFlight > this.inFlightMax) this.inFlightMax = this.inFlight;
  }

  requestFinished(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /**
   * Closes the measurement window and starts a new one. The in-flight peak restarts from what is in flight right
   * now, not from zero: those requests are still there.
   */
  rotate(): RuntimeHealth | undefined {
    if (!this.loop) return undefined;
    const memory = process.memoryUsage();
    const health: RuntimeHealth = {
      eventLoopDelayMs: {
        p50: round3(this.loop.percentile(50) / NS_PER_MS),
        p99: round3(this.loop.percentile(99) / NS_PER_MS),
        max: round3(this.loop.max / NS_PER_MS),
      },
      gcPauseMs: round3(this.gcPauseMs),
      gcCount: this.gcCount,
      heapUsedMb: round3(memory.heapUsed / 1024 / 1024),
      rssMb: round3(memory.rss / 1024 / 1024),
      inFlightMax: this.inFlightMax,
    };
    this.loop.reset();
    this.gcCount = 0;
    this.gcPauseMs = 0;
    this.inFlightMax = this.inFlight;
    return health;
  }
}
