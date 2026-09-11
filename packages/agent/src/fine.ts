/**
 * The fine half of the black box: the last tens of seconds, request by request, operation by operation.
 *
 * `product.md:93` asks for «cada request con sus operaciones hijas, tiempos y **orden**». That last word is the
 * whole reason this exists. The aggregates already say a route ran fifty-six queries; only a sequence with
 * starts and ends says whether they ran one after another or all at once, and that is the difference between
 * time added to the request and time the request spent waiting on something it had already asked for.
 *
 * Three claims the cloud currently refuses to make are waiting on this register: attribution to the critical
 * path (ATR-01), a count of the requests actually harmed (IMP-01), and a unique total across findings (ESC-03).
 *
 * Nothing leaves the process. A capture will freeze it (gh-277).
 */

/** How many requests the ring holds. */
export const DEFAULT_REQUESTS = 4096;

/** How many operations the ring holds, across all of them. */
export const DEFAULT_OPERATIONS = 32_768;

/** How many operations one request may contribute before it is truncated. */
export const DEFAULT_OPERATIONS_PER_REQUEST = 256;

/**
 * What this register may allocate, in bytes. Asserted by a test rather than promised by a comment: it is the
 * half of invariant 3 that does not need a quiet machine, and since the ADR 0032 the other half is manual.
 */
export const FINE_MAX_BYTES = 2 * 1024 * 1024;

/** Fields of one request row. */
const R_START = 0;
const R_DURATION = 1;
const R_STATUS = 2;
const R_ROUTE = 3;
/** The absolute operation cursor this request's operations begin at. */
const R_OP_FROM = 4;
const R_OP_COUNT = 5;
/** 1 when the request contributed more operations than it was allowed to keep. */
const R_TRUNCATED = 6;
const R_FIELDS = 7;

/** Fields of one operation row. */
const O_FINGERPRINT = 0;
/** Start and end, in milliseconds from the start of the request that owns it. */
const O_START = 1;
const O_END = 2;
const O_FIELDS = 3;

/** One operation, as a reader sees it. */
export interface FineOperation {
  /** The fingerprint's hash. Never the text: only the hash travels here (invariant 5). */
  hash: string;
  startMs: number;
  endMs: number;
}

/** One request and what it ran. */
export interface FineRequest {
  method: string;
  route: string;
  status: number;
  /**
   * When it started, in milliseconds since the epoch. Absolute and not process-relative: an instant that
   * only means something inside this process cannot be compared with the start of a capture, which comes
   * from the cloud, nor read beside another instance's (gh-399).
   */
  startedAt: number;
  durationMs: number;
  /** In the order they started. */
  operations: FineOperation[];
  /** True when this request ran more operations than the register keeps per request. */
  truncated: boolean;
  /**
   * True when the operations of this request were overwritten before it was read. The request is still real and
   * its timing is still true; what is gone is the detail, and saying so beats returning an empty list that reads
   * as "it ran nothing" (invariant 14).
   */
  detailLost: boolean;
}

export interface FineCoverage {
  /** How many requests and operations the rings hold. */
  requestCapacity: number;
  operationCapacity: number;
  /** Requests currently readable. */
  requests: number;
  /** Requests whose operations were overwritten. */
  detailLost: number;
  /** Requests that ran more operations than the per-request cap. */
  truncated: number;
}

export interface FineSnapshot {
  requests: FineRequest[];
  coverage: FineCoverage;
}

export interface FineOptions {
  requests?: number;
  operations?: number;
  operationsPerRequest?: number;
}

/**
 * The register.
 *
 * Two rings with **absolute** cursors rather than one array per request. An array per request costs an
 * allocation per request and one per operation; two preallocated typed arrays cost neither. The cursors are
 * monotonic, so an operation is still live exactly when `cursor - its cursor < capacity`, and the two rings can
 * wrap independently without a request ever reading somebody else's operations.
 */
export class FineRegister {
  private readonly capacity: number;
  private readonly opCapacity: number;
  private readonly perRequest: number;
  private readonly requests: Float64Array;
  private readonly operations: Float64Array;
  /** Route labels, interned: a row holds an index, not a string. */
  private readonly routes: string[] = [];
  private readonly routeIndex = new Map<string, number>();
  /** Fingerprints, interned the same way. */
  private readonly fingerprints: string[] = [];
  private readonly fingerprintIndex = new Map<string, number>();
  /** Monotonic write cursors. They only ever grow; the ring position is the cursor modulo the capacity. */
  private requestCursor = 0;
  private operationCursor = 0;

  constructor(options: FineOptions = {}) {
    this.capacity = options.requests ?? DEFAULT_REQUESTS;
    this.opCapacity = options.operations ?? DEFAULT_OPERATIONS;
    this.perRequest = options.operationsPerRequest ?? DEFAULT_OPERATIONS_PER_REQUEST;
    this.requests = new Float64Array(this.capacity * R_FIELDS);
    this.operations = new Float64Array(this.opCapacity * O_FIELDS);
  }

  /** How many operations one request may contribute. The caller stops at this: a request that ran a hundred
   * thousand queries must not empty the ring for everybody else. */
  get operationsPerRequest(): number {
    return this.perRequest;
  }

  /** Where a request's operations will start. Taken when the request opens, written when it finishes. */
  openRequest(): number {
    return this.operationCursor;
  }

  /**
   * One finished operation of the request that is open. `startMs` and `endMs` are relative to that request's
   * start, so the numbers stay small and comparable however long the process has been up.
   */
  operation(hash: string, startMs: number, endMs: number): void {
    const at = (this.operationCursor % this.opCapacity) * O_FIELDS;
    this.operations[at + O_FINGERPRINT] = this.intern(hash, this.fingerprints, this.fingerprintIndex);
    this.operations[at + O_START] = startMs;
    this.operations[at + O_END] = endMs;
    this.operationCursor += 1;
  }

  /**
   * One finished request. `opFrom` is what `openRequest` returned, and `attempted` is how many operations the
   * request ran — which may be more than were written, because the caller stops at the cap. The difference is
   * what makes a truncated request say so instead of passing for a small one.
   */
  request(
    method: string,
    route: string,
    status: number,
    startedAt: number,
    durationMs: number,
    opFrom: number,
    attempted: number,
  ): void {
    // Bounded three ways: what the request ran, what a request is allowed to keep, and what was actually
    // written. The third is what stops a caller that reports more than it wrote from making the snapshot read
    // rows belonging to the next request.
    const kept = Math.min(attempted, this.perRequest, this.operationCursor - opFrom);
    const at = (this.requestCursor % this.capacity) * R_FIELDS;
    this.requests[at + R_START] = startedAt;
    this.requests[at + R_DURATION] = durationMs;
    this.requests[at + R_STATUS] = status;
    this.requests[at + R_ROUTE] = this.intern(`${method} ${route}`, this.routes, this.routeIndex);
    this.requests[at + R_OP_FROM] = opFrom;
    this.requests[at + R_OP_COUNT] = kept;
    this.requests[at + R_TRUNCATED] = attempted > kept ? 1 : 0;
    this.requestCursor += 1;
  }

  /** Exactly how many bytes of typed array this register has allocated. */
  bytes(): number {
    return this.requests.byteLength + this.operations.byteLength;
  }

  /** Everything the register holds, oldest request first. This is what a capture will freeze. */
  snapshot(): FineSnapshot {
    const live = Math.min(this.requestCursor, this.capacity);
    const from = this.requestCursor - live;
    const out: FineRequest[] = [];
    let detailLost = 0;
    let truncated = 0;
    for (let cursor = from; cursor < this.requestCursor; cursor += 1) {
      const at = (cursor % this.capacity) * R_FIELDS;
      const opFrom = this.requests[at + R_OP_FROM] ?? 0;
      const opCount = this.requests[at + R_OP_COUNT] ?? 0;
      // An operation is live exactly while the cursor has not lapped it. Checking the **oldest** one is enough:
      // they were written in order, so if the first survived, all of them did.
      const lost = opCount > 0 && this.operationCursor - opFrom > this.opCapacity;
      const operations: FineOperation[] = [];
      if (!lost) {
        for (let i = 0; i < opCount; i += 1) {
          const opAt = ((opFrom + i) % this.opCapacity) * O_FIELDS;
          operations.push({
            hash: this.fingerprints[this.operations[opAt + O_FINGERPRINT] ?? 0] ?? "",
            startMs: this.operations[opAt + O_START] ?? 0,
            endMs: this.operations[opAt + O_END] ?? 0,
          });
        }
      } else {
        detailLost += 1;
      }
      const isTruncated = (this.requests[at + R_TRUNCATED] ?? 0) === 1;
      if (isTruncated) truncated += 1;
      const label = this.routes[this.requests[at + R_ROUTE] ?? 0] ?? " ";
      const space = label.indexOf(" ");
      out.push({
        method: space < 0 ? label : label.slice(0, space),
        route: space < 0 ? "" : label.slice(space + 1),
        status: this.requests[at + R_STATUS] ?? 0,
        startedAt: this.requests[at + R_START] ?? 0,
        durationMs: this.requests[at + R_DURATION] ?? 0,
        operations,
        truncated: isTruncated,
        detailLost: lost,
      });
    }
    return {
      requests: out,
      coverage: {
        requestCapacity: this.capacity,
        operationCapacity: this.opCapacity,
        requests: out.length,
        detailLost,
        truncated,
      },
    };
  }

  /** Interning: a row holds an index into a table, so a repeated route or fingerprint costs nothing. */
  private intern(value: string, table: string[], index: Map<string, number>): number {
    const known = index.get(value);
    if (known !== undefined) return known;
    const at = table.length;
    table.push(value);
    index.set(value, at);
    return at;
  }
}
