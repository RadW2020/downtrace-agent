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
    this.observer?.disconnect();
    this.observer = undefined;
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
