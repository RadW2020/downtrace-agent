import { describe, expect, it } from "vitest";
import { runWarmup, type WarmupSlice } from "../src/warmup.ts";

/** A fake application: `failingSeconds` seconds of 503s after start, clean afterwards. */
function coldApp(failingSeconds: number): (second: number) => Promise<WarmupSlice> {
  return async (second) => (second <= failingSeconds ? { errors: 40, errorStatuses: { "503": 40 } } : { errors: 0 });
}

describe("runWarmup", () => {
  it("measures after exactly cleanSec seconds when the app is clean from the start", async () => {
    const seen: number[] = [];
    const r = await runWarmup({ cleanSec: 3, maxSec: 30 }, async (s) => {
      seen.push(s);
      return { errors: 0 };
    });
    expect(r).toEqual({ seconds: 3, clean: true, lastErrors: 0 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("waits out a cold start: failing seconds do not count, the clean streak restarts", async () => {
    const r = await runWarmup({ cleanSec: 3, maxSec: 30 }, coldApp(4));
    expect(r).toEqual({ seconds: 7, clean: true, lastErrors: 0 });
  });

  it("a single failed second in the middle resets the streak", async () => {
    const r = await runWarmup({ cleanSec: 3, maxSec: 30 }, async (s) => ({ errors: s === 2 ? 1 : 0 }));
    expect(r.seconds).toBe(5); // 1 ok, 2 bad, 3-4-5 ok
    expect(r.clean).toBe(true);
  });

  it("gives up at maxSec and reports the last second's errors", async () => {
    const r = await runWarmup({ cleanSec: 3, maxSec: 5 }, coldApp(Number.POSITIVE_INFINITY));
    expect(r).toEqual({ seconds: 5, clean: false, lastErrors: 40, lastErrorStatuses: { "503": 40 } });
  });

  it("never asks for less than one clean second and never lets maxSec undercut cleanSec", async () => {
    let calls = 0;
    const r = await runWarmup({ cleanSec: 0, maxSec: 0 }, async () => {
      calls += 1;
      return { errors: 0 };
    });
    expect(calls).toBe(1);
    expect(r.clean).toBe(true);
  });
});
