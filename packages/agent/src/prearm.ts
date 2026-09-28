/**
 * The reserve a prearmed route keeps for itself.
 *
 * `product.md:102` promises that a soft signal makes the instrumentation «it stops overwriting the fine detail of
 * the affected endpoint and extends its window». For that to mean anything there has to be a level below the
 * maximum, and there is not: `FineRegister` is **one global ring with one cursor** (`fine.ts`), so under load a
 * route's detail disappears under the traffic of every other route — and not because anything was shed, since
 * the `OverheadMeter` only gives up detail for its own cost, never for volume.
 *
 * So the level is not lowered for anyone. The armed route gets a reserve of its own that other routes cannot
 * evict (ADR 0122). In the normal case this holds nothing: arming is what fills it, and nothing arms by itself.
 *
 * What it is not: this never sends anything and never asks for a capture. Arming is silent, and an arm that
 * nothing confirms expires having cost a few kilobytes and no network (`product.md:102`).
 */

import type { FineRequest } from "./fine.ts";
import { DEPENDENCY_LABEL_MAX_LENGTH, FINGERPRINT_LABEL_MAX_LENGTH, LabelTable } from "./labels.ts";
import { OTHER_ROUTE } from "./routes.ts";

/** How many routes may be armed at once. Four, like the captures a process may be observing (`captures.ts`). */
export const DEFAULT_ARMED_ROUTES = 4;

/**
 * Requests kept per armed route. Enough to hold the start of an incident at a normal rate, and few enough that
 * four of them together stay a rounding error next to the 2 MiB of the fine register.
 */
export const DEFAULT_REQUESTS_PER_ARMED_ROUTE = 64;

/**
 * Operations the reserve holds across every armed route, from one shared pool. Shared rather than fixed per
 * request for the same reason as the fine register: an N+1 is one request with hundreds of operations and a
 * thousand with one each, and a per-request quota would have to be sized for the worst case in every slot.
 */
export const DEFAULT_PREARM_OPERATIONS = 4_096;

/**
 * What the reserve may occupy, checked by arithmetic in a test (ADR 0067). Two orders of magnitude under the
 * fine register: this is protection for a few routes for a few minutes, not a second black box.
 */
export const PREARM_MAX_BYTES = 192 * 1024;

/**
 * How many distinct fingerprints the reserve may remember. The fine register keeps 512 for the whole process;
 * the reserve sees the traffic of at most four armed routes, and a route runs a handful of distinct queries —
 * so a quarter of the fine register's room, which is what the arithmetic of `PREARM_MAX_BYTES` admits.
 */
export const DEFAULT_PREARM_FINGERPRINT_LABELS = 128;

/**
 * How many distinct dependency labels the reserve may remember. An application has a handful of dependencies,
 * the fine register caps the whole process at 128, and the reserve only sees the armed routes' share of the
 * traffic: half of the fine register's room.
 */
export const DEFAULT_PREARM_DEPENDENCY_LABELS = 64;

/** Fields of one request row, the same shape the fine register keeps plus where its operations begin. */
const R_START = 0;
const R_DURATION = 1;
const R_STATUS = 2;
const R_OP_FROM = 3;
const R_OP_COUNT = 4;
const R_POOL_WAIT = 5;
const R_DEP_FROM = 6;
const R_DEP_COUNT = 7;
const R_FIELDS = 8;

/**
 * Dependency labels kept per armed request. A capture can be about a dependency rather than a route, and
 * `sliceFor` decides that by reading this: a reserve whose rows have no dependencies is a reserve that never
 * matches such a capture. The reserve declared the field and dropped it, which is a silent wrong answer rather
 * than a missing one (gh-498).
 *
 * Four is what the fine register keeps, for the same reason: a request touching more than four distinct
 * dependencies is rare, and the cap is what keeps this bounded.
 */
const DEPS_PER_REQUEST = 4;

const O_FINGERPRINT = 0;
const O_START = 1;
const O_END = 2;
const O_FIELDS = 3;

/** One request as the reserve gives it back, in the shape `sliceFor` already reads. */
export interface PrearmRequest {
  method: string;
  route: string;
  status: number;
  startedAt: number;
  durationMs: number;
  poolWaitMs?: number;
  operations: { hash: string; startMs: number; endMs: number }[];
  dependencies: string[];
}

/** What the register is told about a request that just finished. */
export interface ObservedRequest {
  method: string;
  route: string;
  status: number;
  startedAt: number;
  durationMs: number;
  poolWaitMs?: number;
  operations: { hash: string; startMs: number; endMs: number }[];
  dependencies: string[];
}

export interface PrearmOptions {
  routes?: number;
  requestsPerRoute?: number;
  operations?: number;
  fingerprintLabels?: number;
  dependencyLabels?: number;
}

/** One armed route: which slots are its own, and until when. */
interface Arm {
  label: string;
  armedAt: number;
  until: number;
  written: number;
}

export class PrearmRegister {
  private readonly routeCapacity: number;
  private readonly perRoute: number;
  private readonly opCapacity: number;
  private readonly requests: Float64Array;
  private readonly operations: Float64Array;
  private readonly dependencies: Int32Array;
  /**
   * Dependency labels, interned: a row holds an index, not a string. Bounded, and what does not fit folds
   * into the `(other)` sentinel the fine register folds its dependencies into (gh-805, the brother of
   * gh-765). What the fold costs, said rather than silent (COB-01): a capture of that dependency stops
   * matching the reserve's rows for it — the row stays true and its timing is kept, and the fine register is
   * still the capture's primary source. What it cannot cost: a capture of the armed route itself, whose label
   * is the arm's and lives in the request rows, which the fold never touches.
   */
  private readonly dependencyLabels: LabelTable;
  private readonly methods: string[] = [];
  /**
   * Fingerprints, interned the same way. What the fold costs here is identity, not matching: a capture is
   * never about an operation, so a row whose operation reads `(other)` still answers the captures of its
   * route and of the dependencies it touched — it just cannot say which query that operation was.
   */
  private readonly fingerprintLabels: LabelTable;
  private readonly arms: (Arm | undefined)[];
  private opCursor = 0;
  private shedding = false;
  /** Routes a signal asked to arm and that did not fit. Counted, never silent (invariant 14). */
  routesDropped = 0;
  /** What the label tables had no room for, per row that asked (COB-01). */
  labelsFolded = 0;

  constructor(options: PrearmOptions = {}) {
    this.routeCapacity = options.routes ?? DEFAULT_ARMED_ROUTES;
    this.perRoute = options.requestsPerRoute ?? DEFAULT_REQUESTS_PER_ARMED_ROUTE;
    this.opCapacity = options.operations ?? DEFAULT_PREARM_OPERATIONS;
    this.requests = new Float64Array(this.routeCapacity * this.perRoute * R_FIELDS);
    this.operations = new Float64Array(this.opCapacity * O_FIELDS);
    this.dependencies = new Int32Array(this.routeCapacity * this.perRoute * DEPS_PER_REQUEST);
    // One sentinel, the one the fine register folds into: a fold keeps the row and loses the name.
    this.dependencyLabels = new LabelTable(
      options.dependencyLabels ?? DEFAULT_PREARM_DEPENDENCY_LABELS,
      [OTHER_ROUTE],
      () => OTHER_ROUTE,
    );
    this.fingerprintLabels = new LabelTable(
      options.fingerprintLabels ?? DEFAULT_PREARM_FINGERPRINT_LABELS,
      [OTHER_ROUTE],
      () => OTHER_ROUTE,
    );
    this.arms = new Array(this.routeCapacity).fill(undefined);
    this.methods = new Array(this.routeCapacity * this.perRoute).fill("");
  }

  /**
   * Arms a route until `until`. Returns whether it fits: with every slot taken the answer is no, and the
   * refusal is counted rather than swallowed — a signal that was never acted on has to be visible.
   */
  arm(label: string, now: number, forMs: number): boolean {
    const existing = this.slotOf(label, now);
    if (existing >= 0) {
      const arm = this.arms[existing];
      if (arm) arm.until = now + forMs;
      return true;
    }
    for (let i = 0; i < this.routeCapacity; i++) {
      const arm = this.arms[i];
      if (arm === undefined || arm.until <= now) {
        this.arms[i] = { label, armedAt: now, until: now + forMs, written: 0 };
        return true;
      }
    }
    this.routesDropped++;
    return false;
  }

  /** Whether this route is armed right now. */
  armed(label: string, now: number): boolean {
    return this.slotOf(label, now) >= 0;
  }

  /** When the current arm of this route began, or undefined when it is not armed. */
  armedAt(label: string, now: number): number | undefined {
    const slot = this.slotOf(label, now);
    return slot < 0 ? undefined : this.arms[slot]?.armedAt;
  }

  /**
   * Follows the fine register's shedding. When the instrumentation is already over its budget the reserve is
   * not an exception: arming must never be a way to spend past the budget while the process is suffering
   * (`product.md:241`).
   */
  shed(on: boolean): void {
    this.shedding = on;
  }

  /** Records a request, if its route is armed. Costs nothing for every other request in the process. */
  observe(r: ObservedRequest): void {
    if (this.shedding) return;
    const label = `${r.method} ${r.route}`;
    const slot = this.slotOf(label, r.startedAt);
    if (slot < 0) return;
    const arm = this.arms[slot];
    if (!arm) return;

    const index = slot * this.perRoute + (arm.written % this.perRoute);
    const at = index * R_FIELDS;
    const from = this.opCursor;
    let kept = 0;
    for (const op of r.operations) {
      if (kept >= this.opCapacity) break;
      const o = (this.opCursor % this.opCapacity) * O_FIELDS;
      this.operations[o + O_FINGERPRINT] = this.fingerprintLabels.intern(op.hash);
      if (this.fingerprintLabels.folded) this.labelsFolded += 1;
      this.operations[o + O_START] = op.startMs;
      this.operations[o + O_END] = op.endMs;
      this.opCursor++;
      kept++;
    }
    this.requests[at + R_START] = r.startedAt;
    this.requests[at + R_DURATION] = r.durationMs;
    this.requests[at + R_STATUS] = r.status;
    this.requests[at + R_OP_FROM] = from;
    this.requests[at + R_OP_COUNT] = kept;
    this.requests[at + R_POOL_WAIT] = r.poolWaitMs ?? Number.NaN;
    const depAt = index * DEPS_PER_REQUEST;
    let deps = 0;
    for (const dependency of r.dependencies) {
      if (deps >= DEPS_PER_REQUEST) break;
      this.dependencies[depAt + deps] = this.dependencyLabels.intern(dependency);
      if (this.dependencyLabels.folded) this.labelsFolded += 1;
      deps++;
    }
    this.requests[at + R_DEP_FROM] = depAt;
    this.requests[at + R_DEP_COUNT] = deps;
    this.methods[index] = label;
    arm.written++;
  }

  /**
   * What the reserve kept for this route, oldest first. Empty when the route is not armed, which is the
   * normal case and the reason this costs nothing in a process nobody has armed.
   */
  /**
   * What this route kept, in the shape a capture is assembled from, or `null` when it is not armed.
   *
   * The conversion is here and not at the call site because the two registers answer the same question and a
   * capture must not have to know they are two. `truncated` and `detailLost` are false by construction: the
   * reserve is bounded per route and nobody else writes over it, which is the reason it exists (ADR 0122).
   */
  reserveFor(method: string, route: string, now: number): { armedAt: number; requests: FineRequest[] } | null {
    const label = `${method} ${route}`;
    const armedAt = this.armedAt(label, now);
    if (armedAt === undefined) return null;
    const requests: FineRequest[] = this.requestsFor(label, now).map((r) => {
      const out: FineRequest = {
        method: r.method,
        route: r.route,
        status: r.status,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        operations: r.operations,
        dependencies: r.dependencies,
        truncated: false,
        detailLost: false,
      };
      if (r.poolWaitMs !== undefined && !Number.isNaN(r.poolWaitMs)) out.poolWaitMs = r.poolWaitMs;
      return out;
    });
    return { armedAt, requests };
  }

  requestsFor(label: string, now: number): PrearmRequest[] {
    const slot = this.slotOf(label, now);
    if (slot < 0) return [];
    const arm = this.arms[slot];
    if (!arm) return [];

    const out: PrearmRequest[] = [];
    const held = Math.min(arm.written, this.perRoute);
    const first = arm.written - held;
    const space = label.indexOf(" ");
    for (let n = 0; n < held; n++) {
      const index = slot * this.perRoute + ((first + n) % this.perRoute);
      if (this.methods[index] !== label) continue;
      const at = index * R_FIELDS;
      const from = this.requests[at + R_OP_FROM] ?? 0;
      const count = this.requests[at + R_OP_COUNT] ?? 0;
      const operations = [];
      for (let i = 0; i < count; i++) {
        const o = ((from + i) % this.opCapacity) * O_FIELDS;
        operations.push({
          hash: this.fingerprintLabels.labels[this.operations[o + O_FINGERPRINT] ?? 0] ?? "",
          startMs: this.operations[o + O_START] ?? 0,
          endMs: this.operations[o + O_END] ?? 0,
        });
      }
      const wait = this.requests[at + R_POOL_WAIT] ?? Number.NaN;
      const depFrom = this.requests[at + R_DEP_FROM] ?? 0;
      const depCount = this.requests[at + R_DEP_COUNT] ?? 0;
      const dependencies: string[] = [];
      for (let i = 0; i < depCount; i += 1) {
        dependencies.push(this.dependencyLabels.labels[this.dependencies[depFrom + i] ?? 0] ?? "");
      }
      out.push({
        method: space < 0 ? label : label.slice(0, space),
        route: space < 0 ? "" : label.slice(space + 1),
        status: this.requests[at + R_STATUS] ?? 0,
        startedAt: this.requests[at + R_START] ?? 0,
        durationMs: this.requests[at + R_DURATION] ?? 0,
        operations,
        dependencies,
        ...(Number.isNaN(wait) ? {} : { poolWaitMs: wait }),
      });
    }
    return out;
  }

  /**
   * What the reserve holds, in bytes: the rings and the label tables the rows point at. The tables are
   * counted by the same arithmetic the reserve uses, so a budget that leaves them out is not an option — that
   * blindness is how gh-765 grew, and gh-805 is the same growth that was still left (ADR 0067).
   */
  bytes(): number {
    return (
      this.requests.byteLength +
      this.operations.byteLength +
      this.dependencies.byteLength +
      this.dependencyLabels.bytes +
      this.fingerprintLabels.bytes
    );
  }

  /**
   * What the reserve may hold, in bytes, at its worst: the rings, and every label table at its cap with every
   * label at its longest. The rings are never freed and the tables never shrink, so the worst case is what the
   * reserve really holds once it is full — a number, not a promise (ADR 0067, gh-765, gh-805).
   */
  reservedBytes(): number {
    return (
      this.requests.byteLength +
      this.operations.byteLength +
      this.dependencies.byteLength +
      this.dependencyLabels.worstBytes(DEPENDENCY_LABEL_MAX_LENGTH) +
      this.fingerprintLabels.worstBytes(FINGERPRINT_LABEL_MAX_LENGTH)
    );
  }

  private slotOf(label: string, now: number): number {
    for (let i = 0; i < this.routeCapacity; i++) {
      const arm = this.arms[i];
      if (arm && arm.label === label && arm.until > now) return i;
    }
    return -1;
  }
}
