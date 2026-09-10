/**
 * What the instrumentation costs, measured while it runs — and what it gives up when it costs too much.
 *
 * `product.md:241`: «si detecta que ella misma añade latencia, **se autolimita**». Two words carry the whole
 * design: *detects* needs a measurement that did not exist, and *self-limits* needs somewhere to give ground
 * that is not the product itself (ADR 0080, gh-271).
 *
 * Invariant 3 is both what this has to respect and what it defends. The bench answers "what does this cost?"
 * on a quiet machine, with and without; it cannot answer "is it costing too much **right now, here**", and
 * that is the question a self-limit is made of.
 */

/**
 * One in how many hook invocations is timed.
 *
 * Timing every one costs two `performance.now()` per hook, which is exactly the spend invariant 3 bounds.
 * Timing one in 64 costs an increment and a comparison in the other 63, and over the thousands of hooks a
 * busy second produces the estimate is steady enough to act on. A power of two so the modulo is a mask.
 */
export const SAMPLE_EVERY = 64;

/**
 * How many requests make a window before the level is re-decided.
 *
 * Separate from the sampling period, which is a different question: how often to time a hook is about the
 * cost of measuring, and how many requests to average over is about not reacting to a burst. Tying them
 * together made a meter that sampled every call also decide on every request, which is a meter with no
 * memory.
 */
export const WINDOW_REQUESTS = 64;

/**
 * How much of a request the hooks may take before the instrumentation starts giving ground, in milliseconds.
 *
 * Half of what invariant 3 allows. Triggering at the invariant's own +1 ms would mean self-limiting only
 * once the promise is already broken; the point is to move before that.
 */
export const OVERHEAD_BUDGET_MS = 0.5;

/**
 * What is given up, cheapest loss first — and where it stops.
 *
 * Below `Profile` is the aggregate, which **is** the product. An instrumentation that shed that would be
 * alive and saying nothing, which is invariant 14 upside down: no data must never be able to mean nothing
 * happened. So the floor is a floor, and when shedding everything above it is not enough the agent says so
 * rather than gutting itself.
 */
export const Sheddable = {
  /** Nothing given up. */
  Nothing: 0,
  /** The fine detail: the most expensive thing per operation, and nothing outside a capture reads it yet. */
  Fine: 1,
  /** The profile: loses the labels of what a route runs, keeps every aggregate. */
  Profile: 2,
} as const;

export type SheddableLevel = (typeof Sheddable)[keyof typeof Sheddable];

/** Why something is being given up, in words that go into the agent's own stats. */
export const ThrottleReasons = {
  Latency: "the instrumentation's own hooks were taking too long per request",
  Memory: "the registers were close to their memory budget",
} as const;

export interface OverheadOptions {
  sampleEvery?: number;
  windowRequests?: number;
  budgetMs?: number;
  /** Injected so a test can drive the clock, and so nothing here reaches for a global. */
  now?: () => number;
}

/** What the meter is currently saying. */
export interface OverheadState {
  /** Estimated milliseconds of hook time per request. Zero until the first sample lands. */
  perRequestMs: number;
  /** How much has been given up. */
  shed: SheddableLevel;
  /** Why, or empty when nothing is. */
  reason: string;
  /** How many hook invocations have been timed, out of how many there were. */
  sampled: number;
  hooks: number;
}

export class OverheadMeter {
  private readonly every: number;
  private readonly mask: number;
  private readonly window: number;
  private readonly budget: number;
  private readonly now: () => number;

  /** Hooks seen, and the ones that were timed. */
  private hooks = 0;
  private sampled = 0;
  /** Milliseconds measured in the sampled hooks of the current window. */
  private measuredMs = 0;
  /** Requests in the current window. Never zero when dividing: a window with no requests is not measured. */
  private requests = 0;

  private estimateMs = 0;
  private level: SheddableLevel = Sheddable.Nothing;
  private why = "";

  constructor(opts: OverheadOptions = {}) {
    this.every = opts.sampleEvery ?? SAMPLE_EVERY;
    // A mask when the period is a power of two, which the default is; otherwise fall back to a modulo.
    this.mask = (this.every & (this.every - 1)) === 0 ? this.every - 1 : 0;
    this.window = opts.windowRequests ?? WINDOW_REQUESTS;
    this.budget = opts.budgetMs ?? OVERHEAD_BUDGET_MS;
    this.now = opts.now ?? (() => performance.now());
  }

  /**
   * Called once per hook, before the work. Returns the start instant when this one is being timed, and
   * `undefined` otherwise — which is the cheap path: an increment and a comparison.
   */
  enter(): number | undefined {
    this.hooks += 1;
    const due = this.mask > 0 ? (this.hooks & this.mask) === 0 : this.hooks % this.every === 0;
    if (!due) return undefined;
    return this.now();
  }

  /** Called with whatever `enter` returned. Does nothing when that was `undefined`. */
  leave(started: number | undefined): void {
    if (started === undefined) return;
    this.sampled += 1;
    this.measuredMs += this.now() - started;
  }

  /**
   * Closes a request and re-decides what to give up.
   *
   * Per request and not in total, because per request is what invariant 3 bounds: an agent doing twice the
   * work for twice the traffic is not costing more, it is being used more.
   */
  requestFinished(): void {
    this.requests += 1;
    if (this.sampled === 0 || this.requests < this.window) return;

    // The sampled hooks stand for all of them: one in `every` was timed, so the total is the measured time
    // times the period. An estimate, and named as one.
    const estimatedTotal = this.measuredMs * this.every;
    this.estimateMs = estimatedTotal / this.requests;
    this.measuredMs = 0;
    this.sampled = 0;
    this.requests = 0;
    this.decide();
  }

  /**
   * Gives ground, or takes it back.
   *
   * Shedding at the budget and recovering at half of it, rather than at the same line: with one line a burst
   * makes the level flap, and detail that comes and goes is detail nobody can read.
   */
  private decide(): void {
    if (this.estimateMs > this.budget && this.level < Sheddable.Profile) {
      this.level = (this.level + 1) as SheddableLevel;
      this.why = ThrottleReasons.Latency;
      return;
    }
    if (this.estimateMs < this.budget / 2 && this.level > Sheddable.Nothing) {
      this.level = (this.level - 1) as SheddableLevel;
      if (this.level === Sheddable.Nothing) this.why = "";
    }
  }

  /** Gives ground for a reason that is not latency: the registers are near their memory budget. */
  shedForMemory(): void {
    if (this.level < Sheddable.Fine) {
      this.level = Sheddable.Fine;
      this.why = ThrottleReasons.Memory;
    }
  }

  /** Whether a given piece of work is still being done. */
  keeping(what: SheddableLevel): boolean {
    return this.level < what;
  }

  state(): OverheadState {
    return {
      perRequestMs: this.estimateMs,
      shed: this.level,
      reason: this.why,
      sampled: this.sampled,
      hooks: this.hooks,
    };
  }
}
