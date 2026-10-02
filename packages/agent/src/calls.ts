import { AGGREGATES_SCHEMA_V0 } from "@downtrace/protocol";
import { type OperationKind, operationKey } from "./context.ts";
import { hash64 } from "./fingerprint.ts";

/**
 * What an outgoing HTTP call and a Redis command are, as operations of the route that ran them (DT-17).
 *
 * `product.md:142` promises the detail of a request keeps «outgoing calls by host, Redis operations, with their
 * counts, timings and overlaps», and ADR 0219 gave them their shape: a word and the place it went —
 * `POST api.stripe.com`, `HGETALL cache:6379` — and never a path, a query string, a key or an argument
 * (invariant 5). The word is the method or the command's name, in capitals; the place is the dependency's
 * target, the one its counters are already kept under.
 *
 * A call happens on every call, not once per failure, so its fingerprint is made once per pair — word and place —
 * and kept, the way a query's is (`FingerprintCache`): the path that runs per call is two map lookups, and
 * nothing is hashed or concatenated on it (invariant 3). The key that tells it apart from a query of the same
 * hash is made here too, once, for the same reason.
 */

/** One call's or one command's identity, its label and its key in a request's operations. */
export interface CallFingerprint {
  /** The identity: a digest of the label, or of the withheld label in minimal mode. */
  hash: string;
  /** `POST api.stripe.com`. Empty when the label cannot travel: minimal mode, or a place the schema cannot carry. */
  text: string;
  /** What `operationKey` makes of the kind and the hash, made once here and not on every call. */
  key: string;
}

/**
 * How many distinct pairs one process is expected to call. Beyond this the cache stops growing and the answer
 * is made on each call: still right, only dearer, as the query cache does.
 */
export const DEFAULT_CALL_FINGERPRINTS = 512;

/**
 * The longest word taken for one. HTTP methods and Redis commands are short; anything longer is not a word the
 * label can carry, and keeping it as a key of this cache would be memory the cap does not bound.
 */
const MAX_WORD_LENGTH = 64;

/**
 * The shape the schema requires of a call's and a command's text, read from the schema rather than copied: a
 * label that does not match is a `400` of the whole batch, so the two must not drift (invariant 9).
 */
const LABEL = new RegExp(AGGREGATES_SCHEMA_V0.$defs.Operation.then.properties.text.pattern);
const LABEL_MAX_LENGTH = AGGREGATES_SCHEMA_V0.$defs.Operation.properties.text.maxLength;

export interface CallFingerprintsOptions {
  /**
   * Turns a target into what may leave the process: the withheld name in minimal mode. When it is given, no
   * label is kept at all — minimal mode sends no free text — and the hash is a digest of the withheld name.
   */
  named?: ((target: string) => string) | undefined;
  max?: number;
}

export class CallFingerprints {
  private readonly kind: Extract<OperationKind, "call" | "command">;
  private readonly named: ((target: string) => string) | undefined;
  private readonly max: number;
  /** By target, then by word as the driver gave it: two lookups, and no key built from both. */
  private readonly byTarget = new Map<string, Map<string, CallFingerprint>>();
  private entries = 0;
  /** How many pairs had to be made. Only interesting in tests and when debugging the cost. */
  misses = 0;

  constructor(kind: Extract<OperationKind, "call" | "command">, options: CallFingerprintsOptions = {}) {
    this.kind = kind;
    this.named = options.named;
    this.max = options.max ?? DEFAULT_CALL_FINGERPRINTS;
  }

  get size(): number {
    return this.entries;
  }

  /**
   * The fingerprint of `word` against `target`, or undefined when `word` is not one — what the driver put on its
   * message is `unknown` until it is read, and a call that cannot be named records no operation, only its count.
   */
  get(word: unknown, target: string): CallFingerprint | undefined {
    if (typeof word !== "string" || word === "" || word.length > MAX_WORD_LENGTH) return undefined;
    const byWord = this.byTarget.get(target);
    const cached = byWord?.get(word);
    if (cached) return cached;
    this.misses += 1;
    const fingerprint = this.make(word, target);
    if (this.entries < this.max) {
      if (byWord) byWord.set(word, fingerprint);
      else this.byTarget.set(target, new Map([[word, fingerprint]]));
      this.entries += 1;
    }
    return fingerprint;
  }

  private make(word: string, target: string): CallFingerprint {
    const place = this.named ? this.named(target) : target;
    const label = `${word.toUpperCase()} ${place}`;
    const hash = hash64(label);
    // The label travels only when it is what the schema takes. A Redis reached through a unix socket has a path
    // for a place, and a server the driver did not name has none: both go with their hash alone, which is the
    // identity, rather than with a label the cloud would refuse with the whole batch (ADR 0219).
    const fits = this.named === undefined && label.length <= LABEL_MAX_LENGTH && LABEL.test(label);
    return { hash, text: fits ? label : "", key: operationKey(this.kind, hash) };
  }
}
