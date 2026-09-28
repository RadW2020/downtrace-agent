/**
 * The third register of the black box: a few requests per endpoint, kept as something to compare against.
 *
 * `product.md:100` is the whole of it: «Comparing degraded requests against reference requests requires keeping
 * both; the fine detail of an hour ago no longer exists. That is why the instrumentation keeps, per endpoint and
 * version, a small bounded number of requests representative of the reference in use (…) Every sample identifies its
 * reference and how it was selected; being earlier does not certify health».
 *
 * The selection is the whole design. Keeping the fastest requests would bias every later comparison —any
 * degradation would look worse than it is— and keeping the last ones is cheap and can land on a strange
 * moment. So: **a uniform reservoir per endpoint** (Algorithm R). Every request observed has the same
 * chance of being one of the kept ones, whatever it did, and the criterion travels with the samples
 * because an attribution without its selection is not an attribution (ATR-01).
 *
 * «Por endpoint y versión» comes out by itself: a process runs one deployed version, so the register's
 * own life is that version's.
 */

import type { FineOperation } from "./fine.ts";
import { FINGERPRINT_LABEL_MAX_LENGTH, LabelTable } from "./labels.ts";
import { OTHER_ROUTE } from "./routes.ts";

/** How many endpoints it keeps samples for. */
export const DEFAULT_REFERENCE_ROUTES = 16;

/** How many samples per endpoint. «Un pequeño número acotado». */
export const DEFAULT_SAMPLES_PER_ROUTE = 3;

/** How many operations one sample keeps. */
export const DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE = 32;

/**
 * What this register may allocate, in bytes. Asserted by a test rather than promised by a comment, like
 * the other two halves of the black box.
 */
export const REFERENCE_MAX_BYTES = 64 * 1024;

/**
 * How many distinct fingerprints the register may remember. Its route table is bounded by `routeCapacity`,
 * but a sample's operation fingerprints are not bounded by any slot: a replaced slot can bring a new one, so
 * the table is what bounds them (gh-805, the brother of gh-765). A fourth of the fine register's 512, which
 * is what the arithmetic of `REFERENCE_MAX_BYTES` admits: a sample whose operation reads `(other)` still
 * says its timings, and the loss is counted.
 */
export const DEFAULT_REFERENCE_FINGERPRINT_LABELS = 128;

/** How the samples were chosen. It travels with them; there is no unlabelled selection. */
export const UNIFORM_RESERVOIR = "uniform-reservoir";

/** Fields of one sample row. */
const S_STARTED_AT = 0;
const S_DURATION = 1;
const S_STATUS = 2;
const S_ROUTE = 3;
const S_OPS = 4;
/** 1 when the request ran more operations than a sample keeps. */
const S_TRUNCATED = 5;
/** 1 once this slot holds a sample. A slot with nothing in it is not a request of duration zero. */
const S_FILLED = 6;
const S_FIELDS = 7;

const O_FINGERPRINT = 0;
const O_START = 1;
const O_END = 2;
const O_FIELDS = 3;

export interface ReferenceSample {
  method: string;
  route: string;
  status: number;
  /** Milliseconds since the epoch, like everything that has to be read beside somebody else's clock. */
  startedAt: number;
  durationMs: number;
  operations: FineOperation[];
  /** True when it ran more operations than a sample keeps. Absent means false. */
  truncated?: boolean;
}

export interface ReferenceSnapshot {
  /** How the samples were chosen, published with them (ATR-01). */
  selection: typeof UNIFORM_RESERVOIR;
  /** How many requests they were drawn from. */
  population: number;
  /** Endpoints seen that this register had no room for. Counted rather than silently absent. */
  routesDropped: number;
  /**
   * How many times an operation asked for a fingerprint the table had no room for and kept the sentinel
   * instead. Said rather than silent (COB-01); zero while the table holds what the traffic names.
   */
  labelsFolded: number;
  /**
   * True when requests were observed that this register deliberately did not consider — the renewal was
   * paused. Said once it has happened and not unsaid: the samples in hand are older than the traffic.
   */
  renewalPaused: boolean;
  samples: ReferenceSample[];
}

export interface ReferenceOptions {
  routes?: number;
  samplesPerRoute?: number;
  operationsPerSample?: number;
  fingerprintLabels?: number;
  /** The source of randomness, so a test can make the selection deterministic. */
  random?: () => number;
}

export class ReferenceRegister {
  private readonly routeCapacity: number;
  private readonly perRoute: number;
  private readonly perSample: number;
  private readonly random_: () => number;
  private readonly samples: Float64Array;
  private readonly operations: Float64Array;
  /** How many operations each slot actually holds. */
  private readonly counts: Float64Array;
  /** How many requests each endpoint has been considered for: the reservoir's denominator. */
  private readonly seen: Float64Array;
  private readonly routes: string[] = [];
  private readonly routeIndex = new Map<string, number>();
  /**
   * Fingerprints, interned: an operation slot holds an index, not a string. Bounded, and what does not fit
   * folds into the `(other)` sentinel the fine register folds its fingerprints into (gh-805, the brother of
   * gh-765): the sample stays true and what is lost is the name of the operation, which is counted.
   */
  private readonly fingerprintLabels: LabelTable;
  private paused = false;
  private everPaused = false;
  private dropped = 0;
  private labelsFolded = 0;

  constructor(options: ReferenceOptions = {}) {
    this.routeCapacity = options.routes ?? DEFAULT_REFERENCE_ROUTES;
    this.perRoute = options.samplesPerRoute ?? DEFAULT_SAMPLES_PER_ROUTE;
    this.perSample = options.operationsPerSample ?? DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE;
    const slots = this.routeCapacity * this.perRoute;
    this.samples = new Float64Array(slots * S_FIELDS);
    this.operations = new Float64Array(slots * this.perSample * O_FIELDS);
    this.counts = new Float64Array(slots);
    this.seen = new Float64Array(this.routeCapacity);
    this.fingerprintLabels = new LabelTable(
      options.fingerprintLabels ?? DEFAULT_REFERENCE_FINGERPRINT_LABELS,
      [OTHER_ROUTE],
      () => OTHER_ROUTE,
    );
    this.random_ = options.random ?? Math.random;
  }

  /** Stops renewing. What is kept stays; what runs from here is not considered. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * Offers one finished request to the reservoir.
   *
   * `operations` is a function and not an array because it is only called when the sample is admitted:
   * after the first few requests that happens with probability `samples / seen`, so the copy is rare and
   * the common path is a counter, a random number and a comparison.
   */
  consider(
    method: string,
    route: string,
    status: number,
    startedAt: number,
    durationMs: number,
    operations: () => readonly FineOperation[],
  ): void {
    if (this.paused) {
      this.everPaused = true;
      return;
    }
    const label = `${method} ${route}`;
    let index = this.routeIndex.get(label);
    if (index === undefined) {
      if (this.routes.length >= this.routeCapacity) {
        this.dropped += 1;
        return;
      }
      index = this.routes.length;
      this.routes.push(label);
      this.routeIndex.set(label, index);
    }
    const seen = (this.seen[index] ?? 0) + 1;
    this.seen[index] = seen;

    // Algorithm R: the first `perRoute` requests are kept, and the nth replaces one of them with
    // probability `perRoute / n`. Every request of this endpoint ends up equally likely.
    let slot: number;
    if (seen <= this.perRoute) {
      slot = index * this.perRoute + (seen - 1);
    } else {
      const at = Math.floor(this.random_() * seen);
      if (at >= this.perRoute) return;
      slot = index * this.perRoute + at;
    }
    this.write(slot, index, status, startedAt, durationMs, operations());
  }

  /**
   * What this register holds, in bytes: the arrays and the label table the operation slots point at. The
   * table is counted by the same arithmetic the reserve uses, so a budget that leaves it out is not an option
   * — that blindness is how gh-765 grew, and gh-805 is the same growth that was still left (ADR 0067).
   */
  bytes(): number {
    return (
      this.samples.byteLength +
      this.operations.byteLength +
      this.counts.byteLength +
      this.seen.byteLength +
      this.fingerprintLabels.bytes
    );
  }

  /**
   * What this register may hold, in bytes, at its worst: the arrays, and the label table at its cap with
   * every fingerprint at its longest. The arrays are never freed and the table never shrinks, so the worst
   * case is what the register really holds once it is full — a number, not a promise (ADR 0067, gh-805).
   */
  reservedBytes(): number {
    return (
      this.samples.byteLength +
      this.operations.byteLength +
      this.counts.byteLength +
      this.seen.byteLength +
      this.fingerprintLabels.worstBytes(FINGERPRINT_LABEL_MAX_LENGTH)
    );
  }

  /** What it holds, with how it was chosen and what it was chosen from. */
  snapshot(): ReferenceSnapshot {
    const samples: ReferenceSample[] = [];
    let population = 0;
    for (let i = 0; i < this.routes.length; i += 1) population += this.seen[i] ?? 0;
    for (let slot = 0; slot < this.routeCapacity * this.perRoute; slot += 1) {
      const at = slot * S_FIELDS;
      if ((this.samples[at + S_FILLED] ?? 0) !== 1) continue;
      const count = this.counts[slot] ?? 0;
      const operations: FineOperation[] = [];
      for (let i = 0; i < count; i += 1) {
        const opAt = (slot * this.perSample + i) * O_FIELDS;
        operations.push({
          hash: this.fingerprintLabels.labels[this.operations[opAt + O_FINGERPRINT] ?? 0] ?? "",
          startMs: this.operations[opAt + O_START] ?? 0,
          endMs: this.operations[opAt + O_END] ?? 0,
        });
      }
      const label = this.routes[this.samples[at + S_ROUTE] ?? 0] ?? " ";
      const space = label.indexOf(" ");
      samples.push({
        method: space < 0 ? label : label.slice(0, space),
        route: space < 0 ? "" : label.slice(space + 1),
        status: this.samples[at + S_STATUS] ?? 0,
        startedAt: this.samples[at + S_STARTED_AT] ?? 0,
        durationMs: this.samples[at + S_DURATION] ?? 0,
        operations,
        ...((this.samples[at + S_TRUNCATED] ?? 0) === 1 ? { truncated: true } : {}),
      });
    }
    return {
      selection: UNIFORM_RESERVOIR,
      population,
      routesDropped: this.dropped,
      labelsFolded: this.labelsFolded,
      renewalPaused: this.everPaused,
      samples,
    };
  }

  private write(
    slot: number,
    routeIndex: number,
    status: number,
    startedAt: number,
    durationMs: number,
    operations: readonly FineOperation[],
  ): void {
    const at = slot * S_FIELDS;
    this.samples[at + S_STARTED_AT] = startedAt;
    this.samples[at + S_DURATION] = durationMs;
    this.samples[at + S_STATUS] = status;
    this.samples[at + S_ROUTE] = routeIndex;
    this.samples[at + S_FILLED] = 1;
    const kept = Math.min(operations.length, this.perSample);
    this.samples[at + S_TRUNCATED] = operations.length > kept ? 1 : 0;
    this.counts[slot] = kept;
    for (let i = 0; i < kept; i += 1) {
      const op = operations[i];
      if (op === undefined) continue;
      const opAt = (slot * this.perSample + i) * O_FIELDS;
      this.operations[opAt + O_FINGERPRINT] = this.fingerprintLabels.intern(op.hash);
      if (this.fingerprintLabels.folded) this.labelsFolded += 1;
      this.operations[opAt + O_START] = op.startMs;
      this.operations[opAt + O_END] = op.endMs;
    }
    this.samples[at + S_OPS] = kept;
  }
}
