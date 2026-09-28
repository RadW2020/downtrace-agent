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
