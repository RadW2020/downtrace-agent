export interface WarmupOptions {
  /** Consecutive seconds without a single failed request needed before measuring. */
  cleanSec: number;
  /** Give up after this many seconds of warmup. */
  maxSec: number;
}

export interface WarmupSlice {
  errors: number;
  errorStatuses?: Record<string, number> | undefined;
}

export interface WarmupResult {
  /** Seconds of load actually applied before measuring (or before giving up). */
  seconds: number;
  /** True when the app strung `cleanSec` clean seconds together within `maxSec`. */
  clean: boolean;
  /** Errors of the last warmup second; non-zero only when not clean. */
  lastErrors: number;
  lastErrorStatuses?: Record<string, number> | undefined;
}

/**
 * Warms the application one second of load at a time until it answers
 * `cleanSec` consecutive seconds without errors, or until `maxSec` is spent.
 * A cold database or a slow runner is thereby waited out instead of measured;
 * an application that never recovers is reported, not benchmarked.
 */
export async function runWarmup(
  opts: WarmupOptions,
  runSlice: (second: number) => Promise<WarmupSlice>,
): Promise<WarmupResult> {
  const cleanSec = Math.max(1, Math.floor(opts.cleanSec));
  const maxSec = Math.max(cleanSec, Math.floor(opts.maxSec));
  let streak = 0;
  let last: WarmupSlice = { errors: 0 };
  for (let second = 1; second <= maxSec; second++) {
    last = await runSlice(second);
    streak = last.errors === 0 ? streak + 1 : 0;
    if (streak >= cleanSec) return { seconds: second, clean: true, lastErrors: 0 };
  }
  return { seconds: maxSec, clean: false, lastErrors: last.errors, lastErrorStatuses: last.errorStatuses };
}
