/**
 * When this process started, in the clock the rest of the world reads. `performance.now()` measures
 * durations and never jumps; adding this to one turns it into the instant it happened, which is what an
 * instant in the evidence has to be (gh-399). This is the one place the origin is read: the instrumentation
 * and the command take their instants from here.
 */
export const EPOCH = performance.timeOrigin;

/**
 * The clock in production. `EPOCH + performance.now()` and not `Date.now()`: it is the one the fine register
 * already dates requests with, and an instant that is compared with those has to come from the same place.
 */
export const defaultNow = (): number => EPOCH + performance.now();
