import { errorFingerprint } from "./errors.ts";
import type { Fingerprint } from "./fingerprint.ts";

/**
 * What the process threw outside any request, and how often.
 *
 * `product.md:77` asks for «errors and exceptions», and these are the second word: an exception nobody
 * caught, and a promise rejected with no `catch`. They have no route — they happen outside a request's
 * life, or after it ended — so they travel on the batch and not in the profile (ADR 0102).
 *
 * **How they are watched is the whole difficulty.** `process.on("uncaughtException")` *handles* the
 * exception, and a handled exception does not kill the process: measured, a plain listener turns exit 1
 * with a stack trace into exit 0 with nothing at all. That is what invariant 2 forbids. The agent uses
 * `uncaughtExceptionMonitor`, which Node calls before the real handlers and which does not count as
 * handling anything, so the process ends exactly as it would have (ADR 0103, gh-386).
 */

/** The two kinds, as the protocol spells them. Told apart by the `origin` Node passes, not by two listeners. */
export const UNCAUGHT = "uncaught";
export const UNHANDLED_REJECTION = "unhandled-rejection";
/**
 * And the two ERR-02 adds, which reach this register only when there is **no request to attribute them to**.
 * Inside a request they are operations of the profile, under the route they happened on; here they are what
 * the process saw with no route, which is what this table has always been for.
 *
 * `explicit` lands here whenever the application reports from a background job, a worker or start-up;
 * `framework` only in a process that opens no request contexts at all, which is `DOWNTRACE_INSTRUMENT=none`.
 */
export const FRAMEWORK = "framework";
export const EXPLICIT = "explicit";
export type ExceptionKind = typeof UNCAUGHT | typeof UNHANDLED_REJECTION | typeof FRAMEWORK | typeof EXPLICIT;

/** How many distinct signatures one process is expected to throw before something is very wrong. */
export const MAX_SIGNATURES = 32;

export interface CountedException {
  kind: ExceptionKind;
  hash: string;
  /** Empty when nothing recognisable survived the sanitising, which is not the absence of an exception. */
  text: string;
  count: number;
  /**
   * The structural context the application attached, already sanitised and bounded, or absent when it
   * attached none (ERR-02). The **first** one seen for this signature: what travels is counted per signature
   * and not per occurrence, so there is one context to keep and the first is the one that has an instant.
   */
  context?: Record<string, string> | undefined;
}

/** What `record` needs beyond the thrown thing itself. An object, so neither of the two is positional. */
export interface RecordOptions {
  /** How the signature is computed; minimal mode passes one that keeps the hash and drops the words. */
  sign?: ((e: unknown) => Fingerprint) | undefined;
  /** Sanitised and bounded already: this register stores what it is given and decides nothing about text. */
  context?: Record<string, string> | undefined;
}

/**
 * Counts by signature rather than keeping one entry per throw.
 *
 * A process crashing in a loop is the case that matters most and the one that would produce the most rows,
 * and what a reader asks is how many times — not when each one was.
 */
export class ProcessExceptions {
  private readonly counted = new Map<string, CountedException>();
  private readonly max: number;

  constructor(max = MAX_SIGNATURES) {
    this.max = max;
  }

  get size(): number {
    return this.counted.size;
  }

  /** Records one, from whatever was thrown. Never throws: this runs while the process is on its way out. */
  record(kind: ExceptionKind, err: unknown, opts: RecordOptions = {}): void {
    const { hash, text } = (opts.sign ?? errorFingerprint)(err);
    const key = `${kind}\n${hash}`;
    const seen = this.counted.get(key);
    if (seen) {
      seen.count += 1;
      // The first context stays. A second occurrence of one signature has a context of its own and nowhere
      // to put it: this table counts occurrences and does not date them, so keeping the latest would swap
      // the evidence of the first sighting for that of an arbitrary later one.
      return;
    }
    // Beyond the cap it stops admitting rather than evicting, the same as the fingerprint caches: a process
    // throwing unbounded distinct signatures is the one an LRU would thrash, and the count that is already
    // there stays true.
    if (this.counted.size >= this.max) return;
    const counted: CountedException = { kind, hash, text, count: 1 };
    if (opts.context !== undefined) counted.context = opts.context;
    this.counted.set(key, counted);
  }

  /** What the next batch carries. Taking them clears them: a batch that lands has said them. */
  take(): CountedException[] {
    const out = [...this.counted.values()];
    this.counted.clear();
    return out;
  }

  /** Puts back what a batch could not deliver, so a failed send does not lose them. */
  putBack(all: CountedException[]): void {
    for (const e of all) {
      const key = `${e.kind}\n${e.hash}`;
      const seen = this.counted.get(key);
      if (seen) seen.count += e.count;
      else if (this.counted.size < this.max) this.counted.set(key, e);
    }
  }
}
