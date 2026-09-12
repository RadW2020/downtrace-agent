/**
 * The reserve a prearmed route keeps for itself.
 *
 * `product.md:102` promises that a soft signal makes the instrumentation «deja de sobrescribir el detalle fino
 * del endpoint afectado y extiende su ventana». For that to mean anything there has to be a level below the
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

/** Fields of one request row, the same shape the fine register keeps plus where its operations begin. */
const R_START = 0;
const R_DURATION = 1;
const R_STATUS = 2;
const R_OP_FROM = 3;
const R_OP_COUNT = 4;
const R_POOL_WAIT = 5;
const R_FIELDS = 6;

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
  private readonly methods: string[] = [];
  private readonly fingerprints: string[] = [];
  private readonly fingerprintIndex = new Map<string, number>();
  private readonly arms: (Arm | undefined)[];
  private opCursor = 0;
  private shedding = false;
  /** Routes a signal asked to arm and that did not fit. Counted, never silent (invariant 14). */
  routesDropped = 0;

  constructor(options: PrearmOptions = {}) {
    this.routeCapacity = options.routes ?? DEFAULT_ARMED_ROUTES;
    this.perRoute = options.requestsPerRoute ?? DEFAULT_REQUESTS_PER_ARMED_ROUTE;
    this.opCapacity = options.operations ?? DEFAULT_PREARM_OPERATIONS;
    this.requests = new Float64Array(this.routeCapacity * this.perRoute * R_FIELDS);
    this.operations = new Float64Array(this.opCapacity * O_FIELDS);
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
      this.operations[o + O_FINGERPRINT] = this.fingerprint(op.hash);
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
    this.methods[index] = label;
    arm.written++;
  }

  /**
   * What the reserve kept for this route, oldest first. Empty when the route is not armed, which is the
   * normal case and the reason this costs nothing in a process nobody has armed.
   */
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
          hash: this.fingerprints[this.operations[o + O_FINGERPRINT] ?? 0] ?? "",
          startMs: this.operations[o + O_START] ?? 0,
          endMs: this.operations[o + O_END] ?? 0,
        });
      }
      const wait = this.requests[at + R_POOL_WAIT] ?? Number.NaN;
      out.push({
        method: space < 0 ? label : label.slice(0, space),
        route: space < 0 ? "" : label.slice(space + 1),
        status: this.requests[at + R_STATUS] ?? 0,
        startedAt: this.requests[at + R_START] ?? 0,
        durationMs: this.requests[at + R_DURATION] ?? 0,
        operations,
        dependencies: [],
        ...(Number.isNaN(wait) ? {} : { poolWaitMs: wait }),
      });
    }
    return out;
  }

  /** Preallocated, so this is what it occupies armed or empty. */
  bytes(): number {
    return this.requests.byteLength + this.operations.byteLength;
  }

  private slotOf(label: string, now: number): number {
    for (let i = 0; i < this.routeCapacity; i++) {
      const arm = this.arms[i];
      if (arm && arm.label === label && arm.until > now) return i;
    }
    return -1;
  }

  private fingerprint(hash: string): number {
    let index = this.fingerprintIndex.get(hash);
    if (index === undefined) {
      index = this.fingerprints.length;
      this.fingerprints.push(hash);
      this.fingerprintIndex.set(hash, index);
    }
    return index;
  }
}
