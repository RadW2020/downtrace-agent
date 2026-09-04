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
