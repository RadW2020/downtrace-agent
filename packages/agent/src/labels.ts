import type { Operation } from "@downtrace/protocol";

/**
 * The code each kind of operation is packed as, beside the label of its fingerprint.
 *
 * Every operation a register keeps says its kind, because the evidence has to: an absent kind is «the sender
 * did not say», never a query (ADR 0219). A column of its own would cost a number per operation in three rings
 * whose budgets have no room for one, and the slot that holds the label's index has room to spare: an index is
 * a small integer and a `Float64Array` holds integers exactly up to 2^53. So the slot holds both, at no cost.
 *
 * Zero is no kind at all, which a register reads back as absent rather than guessing one. A `Record` over the
 * protocol's own type, so a kind the schema gains and this table lacks is a compile error, not a silent zero.
 */
const KIND_CODES: Record<Operation["kind"], number> = {
  query: 1,
  error: 2,
  framework: 3,
  explicit: 4,
  call: 5,
  command: 6,
};

/** How many codes one slot leaves room for: the kinds, and zero for none. */
const KIND_SLOTS = 8;

const KINDS_BY_CODE: (Operation["kind"] | undefined)[] = new Array(KIND_SLOTS).fill(undefined);
for (const [kind, code] of Object.entries(KIND_CODES)) KINDS_BY_CODE[code] = kind as Operation["kind"];

/** The label's index and the operation's kind, as the one number a register's slot holds. */
export function packOperation(label: number, kind: Operation["kind"] | undefined): number {
  return label * KIND_SLOTS + (kind === undefined ? 0 : KIND_CODES[kind]);
}

/** The label's index out of a packed slot. */
export function labelOf(packed: number): number {
  return Math.floor(packed / KIND_SLOTS);
}

/** The kind out of a packed slot, or undefined when the operation was written without one. */
export function kindOf(packed: number): Operation["kind"] | undefined {
  return KINDS_BY_CODE[packed % KIND_SLOTS];
}

/**
 * What one interned label costs, in bytes, at its worst.
 *
 * The label is counted as UTF-16 — a Latin-1 string costs half that, so this overcounts rather than
 * undercounts — plus a constant for the runtime's bookkeeping: the string object, its map or set entry and
 * its array slot. The constant has margin rather than being a measurement, because the point is a bound the
 * budget can multiply by a cap, and a bound that undercounts would let the arithmetic pass while the heap
 * disagrees (ADR 0067, gh-765).
 */
export const LABEL_OVERHEAD_BYTES = 128;

/** The worst-case cost of one label of `length` code units. */
export function labelBytes(length: number): number {
  return 2 * length + LABEL_OVERHEAD_BYTES;
}

/**
 * The longest fingerprint label: a hash is sixteen hex characters (`fingerprint.ts`), and the tables that
 * intern them reserve against this.
 */
export const FINGERPRINT_LABEL_MAX_LENGTH = 16;

/**
 * The longest dependency label: its kind — `postgres`, the longest the protocol knows — a separator and the
 * target the instruments clamp to 256.
 */
export const DEPENDENCY_LABEL_MAX_LENGTH = "postgres".length + 1 + 256;

/**
 * A label table: what a row points at by index, so a repeated route or fingerprint costs nothing.
 *
 * The cap is what keeps the table from growing with the traffic that names things (gh-765): a value per
 * request used to add an entry for the whole life of the process. When there is no room for a new value, the
 * row points at the shared sentinel instead of the value — the row stays true and what is lost is the name,
 * which the caller counts (COB-01). Evicting would not be honest: a row would read somebody else's name.
 *
 * The fine, the prearmed reserve and the reference registers keep their labels in one of these (gh-805), so
 * the table and the arithmetic it is checked by live here rather than in any one of them.
 */
export class LabelTable {
  /** The labels, in the order interned. A row holds an index into this, never the label itself. */
  readonly labels: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly room: number;
  private readonly sentinelsCount: number;
  private readonly sentinelOf: (value: string) => string;
  /** What the sentinels cost: fixed, and in the worst case whether or not anything folded. */
  private readonly sentinelBytes: number;
  /** What the table holds, by the same arithmetic `bytes` publishes. */
  private byteCount = 0;
  /** Set by the last `intern`: whether the value did not fit and its sentinel was kept instead. */
  folded = false;

  constructor(room: number, sentinels: string[], sentinelOf: (value: string) => string) {
    this.room = room;
    this.sentinelOf = sentinelOf;
    this.sentinelsCount = sentinels.length;
    this.sentinelBytes = 0;
    for (const sentinel of sentinels) {
      this.labels.push(sentinel);
      this.index.set(sentinel, this.labels.length - 1);
      const cost = labelBytes(sentinel.length);
      this.sentinelBytes += cost;
      this.byteCount += cost;
    }
  }

  /** How many labels the table may hold, sentinels included: what the reserve is the arithmetic of. */
  get capacity(): number {
    return this.room + this.sentinelsCount;
  }

  get bytes(): number {
    return this.byteCount;
  }

  /** The worst case of this table, for a label no longer than `maxLength`: what the reserve is. */
  worstBytes(maxLength: number): number {
    return this.room * labelBytes(maxLength) + this.sentinelBytes;
  }

  /** The index of this value, added the first time it is seen; its sentinel when there is no room. */
  intern(value: string): number {
    const known = this.index.get(value);
    if (known !== undefined) {
      this.folded = false;
      return known;
    }
    this.folded = false;
    if (this.labels.length < this.capacity) {
      const at = this.labels.length;
      this.labels.push(value);
      this.index.set(value, at);
      this.byteCount += labelBytes(value.length);
      return at;
    }
    const at = this.index.get(this.sentinelOf(value));
    if (at === undefined) {
      // The sentinels are interned in the constructor, so this is an internal invariant, not a caller error.
      throw new Error(`the label table lost its sentinel for ${this.sentinelOf(value)}`);
    }
    this.folded = true;
    return at;
  }
}
