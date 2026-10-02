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
import { FINGERPRINT_LABEL_MAX_LENGTH, kindOf, LabelTable, labelBytes, labelOf, packOperation } from "./labels.ts";
import { MAX_ROUTE_LABEL_LENGTH, OTHER_ROUTE } from "./routes.ts";

/** How many endpoints it keeps samples for. */
export const DEFAULT_REFERENCE_ROUTES = 16;

/**
 * How many endpoints whose labels it keeps a 32-bit summary of when the route table has no room: the same
 * 256 as the coarse register's `DEFAULT_DROPPED`, which this counts like it does (gh-775).
 */
export const DEFAULT_REFERENCE_DROPPED = 256;

/** How many samples per endpoint. «Un pequeño número acotado». */
export const DEFAULT_SAMPLES_PER_ROUTE = 3;

/** How many operations one sample keeps. */
export const DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE = 32;

/**
 * What this register may allocate, in bytes. Asserted by a test rather than promised by a comment, like
 * the other two halves of the black box.
 *
 * Raised from sixty-four to seventy-two KiB when the route table entered the count (gh-859): the old line
 * was what an arithmetic admitted that left the table out, and the worst case it then holds — every table
 * at its cap with every label at its longest — crossed it. A line the worst case can cross is not a budget
 * (ADR 0067); the global budget is measured in mebibytes, and this is a fraction of one percent of it.
 */
export const REFERENCE_MAX_BYTES = 72 * 1024;

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

/**
 * A 32-bit FNV-1a of a label, for the dropped table: it says which endpoint a summary is of without the
 * text (invariant 5), and it is what a repeat is recognised by. Two different labels can share one, and a
 * label can hash to `0`, which marks an empty slot: in either case the count stops counting it and stays
 * a lower bound (gh-775).
 */
function droppedDigest(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

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

/** The fingerprint's label and the operation's kind, packed into one number as the fine register packs them. */
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
  /**
   * Endpoints seen that this register had no room for, counted once each: a lower bound once its table of
   * summaries is full, or two of them share a summary. Counted rather than silently absent (gh-775).
   */
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
  /**
   * The endpoints the route table had no room for, as a 32-bit summary of their labels — no text
   * (invariant 5), preallocated, so the table and its arithmetic are fixed from the start (gh-775).
   */
  private readonly droppedSummaries = new Uint32Array(DEFAULT_REFERENCE_DROPPED);
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
        this.noteDropped(label);
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
   * One request for an endpoint the route table has no room for. Counted once per endpoint, not once per
   * request, the way the coarse register counts its dropped routes (gh-775): the number is how many
   * endpoints are missing, not how many requests were refused. The table holds a 32-bit summary of each
   * dropped label so a repeat is recognised; when it is full, or two endpoints share a summary, the count
   * stops and is a lower bound (invariant 3 and 14).
   */
  private noteDropped(label: string): void {
    const digest = droppedDigest(label);
    for (let i = 0; i < this.droppedSummaries.length; i += 1) if ((this.droppedSummaries[i] ?? 0) === digest) return;
    for (let i = 0; i < this.droppedSummaries.length; i += 1) {
      if ((this.droppedSummaries[i] ?? 0) === 0) {
        this.droppedSummaries[i] = digest;
        this.dropped += 1;
        return;
      }
    }
    // No empty slot left: the table is full and the count is a lower bound, not a count.
  }

  /**
   * What the route table holds, by the same arithmetic the reserve uses: each label as UTF-16 plus its
   * bookkeeping (labels.ts). It is not a `LabelTable`, because what does not fit is not folded into a
   * sentinel but dropped — the request is counted in `routesDropped` — and a reference sample that cannot
   * name its endpoint is not a reference to compare against (invariant 14). Bounded by `routeCapacity`, so
   * it never grows with the traffic (gh-765).
   */
  private routeTableBytes(): number {
    let bytes = 0;
    for (const label of this.routes) bytes += labelBytes(label.length);
    return bytes;
  }

  /**
   * What this register holds, in bytes: the arrays, the route table, the dropped table, and the fingerprint
   * table the operation slots point at. Every table is counted by the same arithmetic the reserve uses, so a
   * budget that leaves one out is not an option — that blindness is how gh-765 grew, and gh-805, gh-859 and
   * gh-775 are the same growth that was still left (ADR 0067).
   */
  bytes(): number {
    return (
      this.samples.byteLength +
      this.operations.byteLength +
      this.counts.byteLength +
      this.seen.byteLength +
      this.routeTableBytes() +
      this.droppedSummaries.byteLength +
      this.fingerprintLabels.bytes
    );
  }

  /**
   * What this register may hold, in bytes, at its worst: the arrays, the route table at `routeCapacity`
   * with every label at its longest, the dropped table, preallocated, and the fingerprint table at its cap
   * with every fingerprint at its longest. The arrays are never freed and the tables never shrink, so the
   * worst case is what the register really holds once it is full — a number, not a promise (ADR 0067,
   * gh-805, gh-859, gh-775).
   */
  reservedBytes(): number {
    return (
      this.samples.byteLength +
      this.operations.byteLength +
      this.counts.byteLength +
      this.seen.byteLength +
      this.routeCapacity * labelBytes(MAX_ROUTE_LABEL_LENGTH) +
      this.droppedSummaries.byteLength +
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
        const packed = this.operations[opAt + O_FINGERPRINT] ?? 0;
        const operation: FineOperation = {
          hash: this.fingerprintLabels.labels[labelOf(packed)] ?? "",
          startMs: this.operations[opAt + O_START] ?? 0,
          endMs: this.operations[opAt + O_END] ?? 0,
        };
        // Only when it was written with one: absent is «did not say», never a guess (ADR 0219).
        const kind = kindOf(packed);
        if (kind !== undefined) operation.kind = kind;
        operations.push(operation);
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
      this.operations[opAt + O_FINGERPRINT] = packOperation(this.fingerprintLabels.intern(op.hash), op.kind);
      if (this.fingerprintLabels.folded) this.labelsFolded += 1;
      this.operations[opAt + O_START] = op.startMs;
      this.operations[opAt + O_END] = op.endMs;
    }
    this.samples[at + S_OPS] = kept;
  }
}
