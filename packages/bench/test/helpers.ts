/** Narrows an optional value in tests, failing loudly instead of asserting with `!`. */
export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}
