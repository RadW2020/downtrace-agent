/**
 * The fine half of the black box: the last tens of seconds, request by request, operation by operation.
 *
 * `product.md:93` asks for «each request with its child operations, timings and order». That last word is the
 * whole reason this exists. The aggregates already say a route ran fifty-six queries; only a sequence with
 * starts and ends says whether they ran one after another or all at once, and that is the difference between
 * time added to the request and time the request spent waiting on something it had already asked for.
 *
 * Three claims the cloud currently refuses to make are waiting on this register: attribution to the critical
 * path (ATR-01), a count of the requests actually harmed (IMP-01), and a unique total across findings (ESC-03).
 *
 * Nothing leaves the process. A capture will freeze it (gh-277).
 */

import { EVIDENCE_REQUESTS_MAX_ITEMS_V0, type Operation } from "@downtrace/protocol";
import {
  DEPENDENCY_LABEL_MAX_LENGTH,
  FINGERPRINT_LABEL_MAX_LENGTH,
  kindOf,
  LabelTable,
  labelOf,
  packOperation,
} from "./labels.ts";
import { DEFAULT_ARMED_ROUTES, DEFAULT_REQUESTS_PER_ARMED_ROUTE } from "./prearm.ts";
import { MAX_ROUTE_LABEL_LENGTH, METHODS, OTHER_ROUTE } from "./routes.ts";

/**
 * How many requests the ring holds: the evidence's `maxItems`, generated from the schema, minus what the
 * prearmed reserves hold. A capture without a route reads the ring plus every armed route's reserve at
 * once, and the sum may not pass the cap — the cloud refuses an evidence past it whole, and a refused
 * evidence is the capture expiring without it (gh-901). The reserves' room comes out of the prearm's own
 * constants, not a number copied here: the two sides have to agree, and a copy is where they would drift.
 */
export const DEFAULT_REQUESTS =
  EVIDENCE_REQUESTS_MAX_ITEMS_V0 - DEFAULT_ARMED_ROUTES * DEFAULT_REQUESTS_PER_ARMED_ROUTE;

/** How many operations the ring holds, across all of them. */
export const DEFAULT_OPERATIONS = 32_768;

/** How many operations one request may contribute before it is truncated. */
export const DEFAULT_OPERATIONS_PER_REQUEST = 256;

/**
 * How many distinct dependencies one request may have kept. Eight is well past what a request touches —a
 * database, a cache and two services is four— and the cap is what keeps the ring a fixed size. A request
 * that touched more says so, and a capture of a dependency keeps it rather than deciding it did not use it
 * (gh-397).
 */
export const DEFAULT_DEPENDENCIES_PER_REQUEST = 8;

/**
 * What this register may allocate, in bytes. Asserted by a test rather than promised by a comment: it is the
 * half of invariant 3 that does not need a quiet machine, and since the ADR 0032 the other half is manual.
 *
 * The rings and the label tables together, at their caps: the tables hold what the rows point at, and a budget
 * that leaves them out is the budget that did not see gh-765 grow.
 */
export const FINE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many distinct route labels the register keeps for the life of the process. At least as many as the
 * interval aggregate holds at once (its 500 per interval), so the black box knows every route the aggregate
 * can name, and nothing more than the budget admits.
 */
export const DEFAULT_ROUTE_LABELS = 512;

/** How many distinct fingerprints the register keeps. The FingerprintCache keeps a thousand; this keeps half. */
export const DEFAULT_FINGERPRINT_LABELS = 512;

/** How many distinct dependency labels the register keeps: a request touches a handful, and a capture of one
 * is what a lost label costs. */
export const DEFAULT_DEPENDENCY_LABELS = 128;

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
/** Where this request's dependency labels begin, and how many were kept. */
const R_DEP_FROM = 7;
const R_DEP_COUNT = 8;
/** 1 when the request touched more distinct dependencies than were kept. */
const R_DEP_TRUNCATED = 9;
/**
 * How long this request waited for a connection from a pool, in milliseconds.
 *
 * `NaN` when it asked no pool for one, which is **not** a wait of zero: zero is a request that asked and got
 * one at once. A row is a `Float64Array` and every slot starts at zero, so the absence needs a value of its
 * own or «did not ask» would read as «did not wait» (invariant 14, gh-471).
 */
const R_POOL_WAIT = 10;
const R_FIELDS = 11;

/**
 * Fields of one operation row. The fingerprint's slot holds its label's index and the operation's kind packed
 * into one number (`labels.ts`): the evidence names the kind of every operation (ADR 0219), and a column for it
 * is a number per operation the budget has no room for.
 */
const O_FINGERPRINT = 0;
/** Start and end, in milliseconds from the start of the request that owns it. */
const O_START = 1;
const O_END = 2;
const O_FIELDS = 3;

/** One operation, as a reader sees it. */
export interface FineOperation {
  /** The fingerprint's hash. Never the text: only the hash travels here (invariant 5). */
  hash: string;
  /**
   * What kind of operation it is. Absent only when it was written without one, which a reader takes as «did not
   * say» and never as a query (ADR 0219).
   */
  kind?: Operation["kind"];
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
  /**
   * What it spent waiting for a connection from a pool. Absent when it asked no pool: the pool-saturation
   * trigger compares wait per request, and a request that never queued is not one that queued for nothing.
   */
  poolWaitMs?: number;
  /**
   * In the order they were written, which is when each one **ended**: two calls in flight end in whatever order
   * the network decides. The evidence puts them in the order they started, which is what its contract says.
   */
  operations: FineOperation[];
  /**
   * The dependencies this request touched, as `kind|target` — the same label the aggregates are keyed by,
   * and already withheld in minimal mode. What a capture of a dependency is filtered by (gh-397).
   */
  dependencies: string[];
  /** True when it touched more distinct dependencies than the register keeps. Absent means false. */
  dependenciesTruncated?: boolean;
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
  /**
   * How many times a row asked for a label the tables had no room for and kept the sentinel instead — a route
   * reading as `(other)`, an operation or a dependency the same. Said rather than silent (COB-01); zero while
   * the tables hold what the traffic names.
   */
  labelsFolded: number;
}

export interface FineSnapshot {
  requests: FineRequest[];
  coverage: FineCoverage;
}

export interface FineOptions {
  requests?: number;
  operations?: number;
  operationsPerRequest?: number;
  dependenciesPerRequest?: number;
  routeLabels?: number;
  fingerprintLabels?: number;
  dependencyLabels?: number;
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
  private readonly depsPerRequest: number;
  private readonly requests: Float64Array;
  private readonly operations: Float64Array;
  /**
   * Dependency labels, one ring like the operations'. Sized so a **live** request's labels are always live
   * too —capacity times the per-request cap— which is what stops a lapped ring from making a request look
   * like one that touched nothing.
   */
  private readonly dependencies: Float64Array;
  /**
   * Route labels, interned: a row holds an index, not a string. Bounded, and what does not fit folds into the
   * method's `(other)` sentinel — the same fold the interval aggregate makes of the routes it has no row for.
   */
  private readonly routeLabels: LabelTable;
  /** Fingerprints, interned the same way. */
  private readonly fingerprintLabels: LabelTable;
  /** Dependency labels, interned the same way. */
  private readonly dependencyLabels: LabelTable;
  /** Monotonic write cursors. They only ever grow; the ring position is the cursor modulo the capacity. */
  private requestCursor = 0;
  private operationCursor = 0;
  private dependencyCursor = 0;
  /** What the label tables had no room for, per row that asked (COB-01). */
  private labelsFolded = 0;

  constructor(options: FineOptions = {}) {
    this.capacity = options.requests ?? DEFAULT_REQUESTS;
    this.opCapacity = options.operations ?? DEFAULT_OPERATIONS;
    this.perRequest = options.operationsPerRequest ?? DEFAULT_OPERATIONS_PER_REQUEST;
    this.depsPerRequest = options.dependenciesPerRequest ?? DEFAULT_DEPENDENCIES_PER_REQUEST;
    this.requests = new Float64Array(this.capacity * R_FIELDS);
    this.operations = new Float64Array(this.opCapacity * O_FIELDS);
    this.dependencies = new Float64Array(this.capacity * this.depsPerRequest);
    // One sentinel per method a label may carry: a fold keeps the method and loses the route.
    this.routeLabels = new LabelTable(
      options.routeLabels ?? DEFAULT_ROUTE_LABELS,
      [...METHODS, "OTHER"].map((m) => `${m} ${OTHER_ROUTE}`),
      (v) => `${v.slice(0, v.indexOf(" "))} ${OTHER_ROUTE}`,
    );
    this.fingerprintLabels = new LabelTable(
      options.fingerprintLabels ?? DEFAULT_FINGERPRINT_LABELS,
      [OTHER_ROUTE],
      () => OTHER_ROUTE,
    );
    this.dependencyLabels = new LabelTable(
      options.dependencyLabels ?? DEFAULT_DEPENDENCY_LABELS,
      [OTHER_ROUTE],
      () => OTHER_ROUTE,
    );
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
  operation(hash: string, kind: Operation["kind"], startMs: number, endMs: number): void {
    const at = (this.operationCursor % this.opCapacity) * O_FIELDS;
    this.operations[at + O_FINGERPRINT] = packOperation(this.fingerprintLabels.intern(hash), kind);
    if (this.fingerprintLabels.folded) this.labelsFolded += 1;
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
    dependencies?: Iterable<string>,
    // Positional like the rest, and a value rather than a flag: an options object here would allocate one
    // per request on the hottest path the product has, which is what the register exists to stay off.
    poolWaitMs: number = Number.NaN,
  ): void {
    // Bounded three ways: what the request ran, what a request is allowed to keep, and what was actually
    // written. The third is what stops a caller that reports more than it wrote from making the snapshot read
    // rows belonging to the next request.
    const kept = Math.min(attempted, this.perRequest, this.operationCursor - opFrom);
    const at = (this.requestCursor % this.capacity) * R_FIELDS;
    this.requests[at + R_START] = startedAt;
    this.requests[at + R_DURATION] = durationMs;
    this.requests[at + R_POOL_WAIT] = poolWaitMs;
    this.requests[at + R_STATUS] = status;
    this.requests[at + R_ROUTE] = this.routeLabels.intern(`${method} ${route}`);
    if (this.routeLabels.folded) this.labelsFolded += 1;
    this.requests[at + R_OP_FROM] = opFrom;
    this.requests[at + R_OP_COUNT] = kept;
    this.requests[at + R_TRUNCATED] = attempted > kept ? 1 : 0;
    // The labels are written here, at the end, because a request's dependencies are only complete when it
    // finishes. Contiguous from the cursor, so no request ever reads another's (the same rule as above).
    const depFrom = this.dependencyCursor;
    let deps = 0;
    let overflow = false;
    if (dependencies !== undefined) {
      for (const label of dependencies) {
        if (deps >= this.depsPerRequest) {
          overflow = true;
          break;
        }
        const slot = (this.dependencyCursor + deps) % this.dependencies.length;
        this.dependencies[slot] = this.dependencyLabels.intern(label);
        if (this.dependencyLabels.folded) this.labelsFolded += 1;
        deps += 1;
      }
    }
    this.dependencyCursor += deps;
    this.requests[at + R_DEP_FROM] = depFrom;
    this.requests[at + R_DEP_COUNT] = deps;
    this.requests[at + R_DEP_TRUNCATED] = overflow ? 1 : 0;
    this.requestCursor += 1;
  }

  /**
   * The operations of the request written last, or none when it kept none.
   *
   * For the reference register, which copies a sample **only when it takes one** (gh-307): asking the
   * ring costs nothing until then, and the request it asks about is the one just written, so its
   * operations are necessarily still live.
   */
  lastOperations(): FineOperation[] {
    if (this.requestCursor === 0) return [];
    const at = ((this.requestCursor - 1) % this.capacity) * R_FIELDS;
    const opFrom = this.requests[at + R_OP_FROM] ?? 0;
    const opCount = this.requests[at + R_OP_COUNT] ?? 0;
    const out: FineOperation[] = [];
    for (let i = 0; i < opCount; i += 1) out.push(this.operationOf(opFrom + i));
    return out;
  }

  /**
   * What this register holds, in bytes: the rings and the label tables the rows point at. The tables are
   * counted by the same arithmetic the reserve uses, so a budget that leaves them out is not an option — that
   * blindness is how gh-765 grew (ADR 0067).
   */
  bytes(): number {
    return (
      this.requests.byteLength +
      this.operations.byteLength +
      this.dependencies.byteLength +
      this.routeLabels.bytes +
      this.fingerprintLabels.bytes +
      this.dependencyLabels.bytes
    );
  }

  /**
   * What this register may hold, in bytes, at its worst: the rings, and every label table at its cap with
   * every label at its longest. The rows are never freed, the tables never shrink, so the worst case is what
   * the register really holds once it is full — a number, not a promise (ADR 0067, gh-765).
   */
  reservedBytes(): number {
    return (
      this.requests.byteLength +
      this.operations.byteLength +
      this.dependencies.byteLength +
      this.routeLabels.worstBytes(MAX_ROUTE_LABEL_LENGTH) +
      this.fingerprintLabels.worstBytes(FINGERPRINT_LABEL_MAX_LENGTH) +
      this.dependencyLabels.worstBytes(DEPENDENCY_LABEL_MAX_LENGTH)
    );
  }

  /** Everything the register holds, oldest request first. This is what a capture will freeze. */
  /**
   * The operations one request wrote, or the news that they are gone.
   *
   * Read from the range the request itself recorded, which is the only way to name them: the register keeps
   * fingerprints and the row keeps a cursor into them. An operation is live exactly while the cursor has not
   * lapped it, and checking the **oldest** is enough — they were written in order, so if the first survived
   * they all did.
   *
   * Public because the prearmed reserve needs the same rows the ring just took (gh-498), and one walk beats
   * two that have to agree about what «lost» means.
   */
  operationsAt(opFrom: number, opCount: number): { operations: FineOperation[]; lost: boolean } {
    if (opCount > 0 && this.operationCursor - opFrom > this.opCapacity) {
      return { operations: [], lost: true };
    }
    const operations: FineOperation[] = [];
    for (let i = 0; i < opCount; i += 1) operations.push(this.operationOf(opFrom + i));
    return { operations, lost: false };
  }

  /** One operation, as a reader sees it, from its absolute cursor. The kind only when it was written with one. */
  private operationOf(cursor: number): FineOperation {
    const at = (cursor % this.opCapacity) * O_FIELDS;
    const packed = this.operations[at + O_FINGERPRINT] ?? 0;
    const operation: FineOperation = {
      hash: this.fingerprintLabels.labels[labelOf(packed)] ?? "",
      startMs: this.operations[at + O_START] ?? 0,
      endMs: this.operations[at + O_END] ?? 0,
    };
    // Assigned rather than spread: the reserve reads this on every request (gh-498), and a spread is an object.
    const kind = kindOf(packed);
    if (kind !== undefined) operation.kind = kind;
    return operation;
  }

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
      const { operations, lost } = this.operationsAt(opFrom, opCount);
      if (lost) detailLost += 1;
      const isTruncated = (this.requests[at + R_TRUNCATED] ?? 0) === 1;
      if (isTruncated) truncated += 1;
      const depFrom = this.requests[at + R_DEP_FROM] ?? 0;
      const depCount = this.requests[at + R_DEP_COUNT] ?? 0;
      const dependencies: string[] = [];
      for (let i = 0; i < depCount; i += 1) {
        const slot = (depFrom + i) % this.dependencies.length;
        dependencies.push(this.dependencyLabels.labels[this.dependencies[slot] ?? 0] ?? "");
      }
      const label = this.routeLabels.labels[this.requests[at + R_ROUTE] ?? 0] ?? " ";
      const space = label.indexOf(" ");
      out.push({
        method: space < 0 ? label : label.slice(0, space),
        route: space < 0 ? "" : label.slice(space + 1),
        status: this.requests[at + R_STATUS] ?? 0,
        startedAt: this.requests[at + R_START] ?? 0,
        durationMs: this.requests[at + R_DURATION] ?? 0,
        operations,
        dependencies,
        truncated: isTruncated,
        detailLost: lost,
        ...((this.requests[at + R_DEP_TRUNCATED] ?? 0) === 1 ? { dependenciesTruncated: true } : {}),
        ...(Number.isNaN(this.requests[at + R_POOL_WAIT] ?? Number.NaN)
          ? {}
          : { poolWaitMs: this.requests[at + R_POOL_WAIT] }),
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
        labelsFolded: this.labelsFolded,
      },
    };
  }
}
