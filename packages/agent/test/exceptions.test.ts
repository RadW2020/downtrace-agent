import { describe, expect, it } from "vitest";
import { MAX_SIGNATURES, ProcessExceptions, UNCAUGHT } from "../src/exceptions.ts";

/**
 * The register stops admitting new signatures at its cap rather than evicting (a process throwing unbounded
 * distinct signatures is the one an eviction would thrash, and the counts already there stay true). What this
 * file pins is the other half, the one gh-650 found missing: an occurrence that does not fit is not admitted
 * **and is counted**, because a register that hands over 32 signatures and was handed 40 leaves the other 10
 * to be read as errors that did not happen (COB-01, invariant 14).
 *
 * What is counted is the **occurrence** and not the signature: a signature that did not fit cannot be counted
 * as distinct without remembering every signature that did not fit, which is a buffer that grows with the
 * very flood it exists to survive, and the budget does not allow it (invariant 3). An occurrence is exact
 * and costs one increment, and it bounds what was lost: at least one more signature, at most as many.
 */

/** Signs by the thrown value itself: distinct values are distinct signatures, and nothing is sanitised away. */
const sign = (e: unknown): { hash: string; text: string } => ({ hash: String(e), text: String(e) });

describe("the register, at its cap", () => {
  it("admits up to the cap, and counts what it stops admitting", () => {
    const reg = new ProcessExceptions();
    for (let i = 0; i < MAX_SIGNATURES; i++) reg.record(UNCAUGHT, `h${i}`, { sign });
    expect(reg.size).toBe(MAX_SIGNATURES);
    expect(reg.takeDropped()).toBe(0);
    for (let i = 100; i < 103; i++) reg.record(UNCAUGHT, `h${i}`, { sign });
    expect(reg.size, "the cap stops admitting rather than evicting").toBe(MAX_SIGNATURES);
    expect(reg.takeDropped()).toBe(3);
    expect(reg.take()).toHaveLength(MAX_SIGNATURES);
  });

  it("counts occurrences, so the same signature that does not fit is counted once per throw", () => {
    const reg = new ProcessExceptions(1);
    reg.record(UNCAUGHT, "first", { sign });
    reg.record(UNCAUGHT, "second", { sign });
    reg.record(UNCAUGHT, "second", { sign });
    expect(reg.size).toBe(1);
    expect(reg.takeDropped()).toBe(2);
  });

  it("counts a throw of a signature it already admits, not a throw that did not fit", () => {
    const reg = new ProcessExceptions(2);
    reg.record(UNCAUGHT, "a", { sign });
    reg.record(UNCAUGHT, "b", { sign });
    reg.record(UNCAUGHT, "c", { sign });
    reg.record(UNCAUGHT, "a", { sign });
    expect(reg.takeDropped()).toBe(1);
    expect(reg.take().find((e) => e.hash === "a")?.count).toBe(2);
  });

  it("opens the window again after a take, and the count goes with what was taken", () => {
    const reg = new ProcessExceptions(2);
    reg.record(UNCAUGHT, "a", { sign });
    reg.record(UNCAUGHT, "b", { sign });
    reg.record(UNCAUGHT, "c", { sign });
    expect(reg.take()).toHaveLength(2);
    // The drop belongs to the take that lost it: read with it, and not again after.
    expect(reg.takeDropped()).toBe(1);
    // The window is empty again, so the signature that did not fit before is admitted now.
    reg.record(UNCAUGHT, "c", { sign });
    expect(reg.size).toBe(1);
    expect(reg.takeDropped()).toBe(0);
  });

  it("says the count once: a second read is zero, not a loss that keeps happening", () => {
    const reg = new ProcessExceptions(1);
    reg.record(UNCAUGHT, "a", { sign });
    reg.record(UNCAUGHT, "b", { sign });
    expect(reg.takeDropped()).toBe(1);
    expect(reg.takeDropped()).toBe(0);
  });
});
