import { OTHER_ROUTE } from "./routes.ts";

/**
 * The coarse half of the black box: the last few minutes, second by second.
 *
 * `product.md` describes it as «los últimos minutos de agregados por segundo y por endpoint … es muy barato y
 * permite ver cómo empezó algo que se detectó tarde». That last clause is the whole point. The interval
 * aggregate says a minute was bad; this says whether it went bad in one step or over forty seconds, and those
 * are different problems with different causes.
 *
 * Nothing here leaves the process. It exists to be frozen by a capture, which does not exist yet.
 *
 * The memory is bounded by construction (invariant 1): every row is a typed array allocated once, at the size of
 * the window, and a second that comes round again overwrites the one from a window ago. Nothing grows.
 */

/** How many seconds the register holds. Five minutes: long enough to see a slope, short enough to be cheap. */
export const DEFAULT_SECONDS = 300;

/**
 * How many routes get a row of their own. Fewer than the interval aggregator's 500 on purpose: this register
 * exists to show the shape of a change, and a route with a request every few minutes has no shape per second.
 * The rest fold into one row, and the coverage says how many did.
 */
export const DEFAULT_ROUTES = 128;

/**
 * What the register may hold, in bytes, at its worst: every row taken, every slot allocated.
 *
 * Invariant 3 says the numbers are «un hecho ejecutable, no una cifra copiada en un documento». The latency and
 * CPU halves are what `make bench` measures; the memory half is arithmetic, and this is where it is asserted —
 * `bytes()` computes what is really allocated and a test holds it under this.
 */
export const MAX_BYTES = 2 * 1024 * 1024;

/** What one second of one route holds. Sums and a maximum: a histogram per second per route would multiply the
 * memory by its buckets to answer a question the interval already answers. */
const REQUESTS = 0;
const ERRORS = 1;
const LATENCY_SUM = 2;
const LATENCY_MAX = 3;
const CALLS = 4;
const FIELDS = 5;

/** One route's window: its numbers, and which second each slot currently holds. */
interface Row {
  method: string;
  route: string;
  /** The epoch second this row was created. Before it, this route had not been seen, and reporting zeros for
   * that stretch would say it was silent when the truth is that nobody was watching. */
  since: number;
  /** `seconds * FIELDS`, indexed by `slot * FIELDS + field`. */
  values: Float64Array;
  /** The epoch second each slot holds, so a slot from a window ago is not read as this one's. */
  stamps: Float64Array;
}

/** One second of one route, as a reader sees it. */
export interface CoarseSecond {
  second: number;
  requests: number;
  errors: number;
  latencySumMs: number;
  latencyMaxMs: number;
  calls: number;
}

export interface CoarseRoute {
  method: string;
  route: string;
  seconds: CoarseSecond[];
}

/**
 * What the register could not hold. Published always, because a reader who cannot tell a quiet route from a
 * dropped one is reading half the picture and does not know it (COB-01 in spirit, invariant 14).
 */
export interface CoarseCoverage {
  /** How many seconds the window spans. */
  windowSeconds: number;
  /** Routes with a row of their own. */
  routes: number;
  /** Distinct routes folded into `(other)` because the register was full. */
  routesDropped: number;
}

export interface CoarseSnapshot {
  routes: CoarseRoute[];
  /** The process's event loop delay, second by second. Not attributed to any route: it is the process's. */
  eventLoop: { second: number; maxDelayMs: number }[];
  coverage: CoarseCoverage;
}

/** Options, all with defaults, so the common case constructs with none. */
export interface CoarseOptions {
  seconds?: number;
  maxRoutes?: number;
  now?: () => number;
}

/**
 * The register. One instance per process.
 *
 * Recording is constant time and allocates nothing after a route's first appearance: an index, a comparison and
 * five additions. That is what makes it affordable to keep always on (invariant 3).
 */
export class CoarseRegister {
  private readonly seconds: number;
  private readonly maxRoutes: number;
  private readonly now: () => number;
  private readonly rows = new Map<string, Row>();
  private distinctRoutes = 0;
  private droppedRoutes = 0;
  /** The dropped routes seen so far, so the same one is not counted twice. */
  private readonly dropped = new Set<string>();
  private readonly loopDelay: Float64Array;
  private readonly loopStamps: Float64Array;

  constructor(options: CoarseOptions = {}) {
    this.seconds = options.seconds ?? DEFAULT_SECONDS;
    this.maxRoutes = options.maxRoutes ?? DEFAULT_ROUTES;
    this.now = options.now ?? Date.now;
    this.loopDelay = new Float64Array(this.seconds);
    this.loopStamps = new Float64Array(this.seconds).fill(Number.NaN);
  }

  /** One finished request. */
  record(method: string, route: string, status: number, ms: number, calls: number): void {
    const row = this.rowFor(method, route);
    if (!row) return;
    const second = Math.floor(this.now() / 1000);
    const slot = ((second % this.seconds) + this.seconds) % this.seconds;
    const at = slot * FIELDS;
    // A slot whose stamp is not this second belongs to a window ago. Cleared here rather than swept once a
    // second, so the cost stays with the write that needs it.
    if (row.stamps[slot] !== second) {
      row.stamps[slot] = second;
      row.values[at + REQUESTS] = 0;
      row.values[at + ERRORS] = 0;
      row.values[at + LATENCY_SUM] = 0;
      row.values[at + LATENCY_MAX] = 0;
      row.values[at + CALLS] = 0;
    }
    const latency = ms >= 0 ? ms : 0;
    row.values[at + REQUESTS] = (row.values[at + REQUESTS] ?? 0) + 1;
    if (status >= 500) row.values[at + ERRORS] = (row.values[at + ERRORS] ?? 0) + 1;
    row.values[at + LATENCY_SUM] = (row.values[at + LATENCY_SUM] ?? 0) + latency;
    if (latency > (row.values[at + LATENCY_MAX] ?? 0)) row.values[at + LATENCY_MAX] = latency;
    row.values[at + CALLS] = (row.values[at + CALLS] ?? 0) + calls;
  }

  /** The process's event loop delay for the current second. The worst reading wins: a second that stalled once
   * stalled, and averaging it away is how a stall becomes invisible. */
  recordEventLoop(maxDelayMs: number): void {
    const second = Math.floor(this.now() / 1000);
    const slot = ((second % this.seconds) + this.seconds) % this.seconds;
    if (this.loopStamps[slot] !== second) {
      this.loopStamps[slot] = second;
      this.loopDelay[slot] = 0;
    }
    if (maxDelayMs > (this.loopDelay[slot] ?? 0)) this.loopDelay[slot] = maxDelayMs;
  }

  /**
   * Exactly how many bytes of typed array this register has allocated. Not an estimate: the rows are the only
   * thing here that scales, and their size is known.
   */
  bytes(): number {
    const perRow = this.seconds * FIELDS * 8 + this.seconds * 8;
    const process = this.seconds * 8 * 2;
    return this.rows.size * perRow + process;
  }

  /** Everything the register holds, oldest second first. This is what a capture will freeze. */
  snapshot(): CoarseSnapshot {
    const now = Math.floor(this.now() / 1000);
    const oldest = now - this.seconds + 1;
    const routes: CoarseRoute[] = [];
    for (const row of this.rows.values()) {
      const seconds: CoarseSecond[] = [];
      // Every second of the window is emitted, from the moment this route was first seen. A second with no
      // traffic is zeros and a second nobody watched is absent, and those are different answers: a route that
      // went silent for thirty seconds is how a great many incidents look (invariant 14).
      for (let second = Math.max(oldest, row.since); second <= now; second += 1) {
        const slot = ((second % this.seconds) + this.seconds) % this.seconds;
        const at = slot * FIELDS;
        if (row.stamps[slot] !== second) {
          seconds.push({ second, requests: 0, errors: 0, latencySumMs: 0, latencyMaxMs: 0, calls: 0 });
          continue;
        }
        seconds.push({
          second,
          requests: row.values[at + REQUESTS] ?? 0,
          errors: row.values[at + ERRORS] ?? 0,
          latencySumMs: row.values[at + LATENCY_SUM] ?? 0,
          latencyMaxMs: row.values[at + LATENCY_MAX] ?? 0,
          calls: row.values[at + CALLS] ?? 0,
        });
      }
      routes.push({ method: row.method, route: row.route, seconds });
    }
    // The event loop is only reported for the seconds somebody sampled it: unlike a route, a second with no
    // reading says nothing about the loop, and a zero would say it was idle.
    const eventLoop: { second: number; maxDelayMs: number }[] = [];
    for (let slot = 0; slot < this.seconds; slot += 1) {
      const second = this.loopStamps[slot];
      if (second === undefined || Number.isNaN(second) || second < oldest) continue;
      eventLoop.push({ second, maxDelayMs: this.loopDelay[slot] ?? 0 });
    }
    eventLoop.sort((a, b) => a.second - b.second);
    return {
      routes,
      eventLoop,
      coverage: {
        windowSeconds: this.seconds,
        routes: this.rows.size,
        routesDropped: this.droppedRoutes,
      },
    };
  }

  /** The row for one route, allocating it the first time and folding into `(other)` once the register is full. */
  private rowFor(method: string, route: string): Row | undefined {
    const key = `${method} ${route}`;
    const existing = this.rows.get(key);
    if (existing) return existing;
    if (route !== OTHER_ROUTE && this.distinctRoutes >= this.maxRoutes) {
      // Counted once per distinct route, not once per request: the number means "how many routes are missing",
      // not "how many requests were folded".
      if (!this.dropped.has(key)) {
        this.dropped.add(key);
        this.droppedRoutes += 1;
      }
      return this.rowFor(method, OTHER_ROUTE);
    }
    if (route !== OTHER_ROUTE) this.distinctRoutes += 1;
    const row: Row = {
      method,
      route,
      since: Math.floor(this.now() / 1000),
      values: new Float64Array(this.seconds * FIELDS),
      stamps: new Float64Array(this.seconds).fill(Number.NaN),
    };
    this.rows.set(key, row);
    return row;
  }
}
