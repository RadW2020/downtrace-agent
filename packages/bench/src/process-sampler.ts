export interface ProcessSnapshot {
  pid: number;
  cpu: { user: number; system: number };
  memory: { rss: number; heapUsed: number; heapTotal: number };
  eventLoopUtilization: { idle: number; active: number; utilization: number };
  uptimeMs: number;
}

export interface ResourceUsage {
  /** CPU time of the app process as a percentage of wall time during the window. */
  cpuPct: number;
  /** Maximum RSS observed during the window, in MiB. */
  rssMaxMb: number;
  /** Event loop utilization during the window, 0..1. */
  elu: number;
}

export async function snapshot(baseUrl: string): Promise<ProcessSnapshot> {
  const res = await fetch(`${baseUrl}/__admin/process`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`/__admin/process responded ${res.status}`);
  return (await res.json()) as ProcessSnapshot;
}

/**
 * How long requests spent waiting for a database connection during the window, summed across routes.
 *
 * The app already counts it per request; this reads it from the same admin surface the sampler uses, resetting at
 * the start of the window so the warmup — where the app is cold on purpose — does not leak into the measurement.
 * A round that ran out of connections shows it here instead of only in a 5000 ms p99 that has to be read as a
 * symptom (gh-177).
 */
export interface PoolWait {
  /** Summed across routes, over the window. */
  totalMs: number;
  /**
   * The longest single wait and when it happened. A total over sixty seconds cannot be lined up with what the
   * database was doing; one instant can, to the second (gh-177).
   */
  maxMs: number;
  maxAt: number | undefined;
}

export async function poolWaitSince(baseUrl: string, reset: boolean): Promise<PoolWait> {
  if (reset) {
    const res = await fetch(`${baseUrl}/__admin/stats/reset`, { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`/__admin/stats/reset responded ${res.status}`);
    return { totalMs: 0, maxMs: 0, maxAt: undefined };
  }
  const res = await fetch(`${baseUrl}/__admin/stats`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`/__admin/stats responded ${res.status}`);
  const stats = (await res.json()) as Record<
    string,
    { poolWaitMs?: number; maxPoolWaitMs?: number; maxPoolWaitAt?: number }
  >;
  const wait: PoolWait = { totalMs: 0, maxMs: 0, maxAt: undefined };
  for (const endpoint of Object.values(stats)) {
    wait.totalMs += endpoint.poolWaitMs ?? 0;
    const worst = endpoint.maxPoolWaitMs ?? 0;
    if (worst > wait.maxMs) {
      wait.maxMs = worst;
      wait.maxAt = endpoint.maxPoolWaitAt;
    }
  }
  return wait;
}

/**
 * Puts the app's database back to a known size. Called before every round: the benchmark's whole method is
 * comparing rounds with each other, and rounds are only comparable if they start equal (ADR 0021). The reference
 * app owns its schema and does the truncating, so this package keeps having no dependencies.
 */
export async function resetDatabase(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/__admin/db/reset`, { method: "POST", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`/__admin/db/reset responded ${res.status}`);
}

/** Samples /__admin/process at the start, periodically (for peak RSS) and at the end of a window. */
export class ProcessSampler {
  private first?: ProcessSnapshot;
  private firstWall = 0;
  private rssMax = 0;
  private timer?: NodeJS.Timeout;
  private readonly baseUrl: string;
  private readonly intervalMs: number;

  constructor(baseUrl: string, intervalMs = 1000) {
    this.baseUrl = baseUrl;
    this.intervalMs = intervalMs;
  }

  async start(): Promise<void> {
    this.first = await snapshot(this.baseUrl);
    this.firstWall = performance.now();
    this.rssMax = this.first.memory.rss;
    this.timer = setInterval(() => {
      snapshot(this.baseUrl)
        .then((s) => {
          this.rssMax = Math.max(this.rssMax, s.memory.rss);
        })
        .catch(() => {});
    }, this.intervalMs);
  }

  async stop(): Promise<ResourceUsage> {
    if (this.timer) clearInterval(this.timer);
    const last = await snapshot(this.baseUrl);
    const first = this.first ?? last;
    const wallUs = (performance.now() - this.firstWall) * 1000;
    const cpuUs = last.cpu.user + last.cpu.system - (first.cpu.user + first.cpu.system);
    const active = last.eventLoopUtilization.active - first.eventLoopUtilization.active;
    const idle = last.eventLoopUtilization.idle - first.eventLoopUtilization.idle;
    this.rssMax = Math.max(this.rssMax, last.memory.rss);
    return {
      cpuPct: wallUs > 0 ? (cpuUs / wallUs) * 100 : 0,
      rssMaxMb: this.rssMax / (1024 * 1024),
      elu: active + idle > 0 ? active / (active + idle) : 0,
    };
  }
}
