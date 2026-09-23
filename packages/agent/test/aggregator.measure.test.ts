import { describe, expect, it } from "vitest";
import { IntervalAggregator } from "../src/aggregator.ts";

/**
 * What the aggregator costs, which is a measurement and therefore does not run in CI.
 *
 * ADR 0032 took the benchmark out of the pipeline because the two runners share a VM, and ADR 0114 extended
 * it to every assertion that talks about a duration rather than about what the code decides. This one lived
 * in the fast suite until it failed there for exactly that reason: 1 of 10 full-suite runs with ten processes
 * spinning, at 54.5 ms against a 50 ms bound (gh-562).
 *
 * Run by `make bench-measure`, on a quiet machine, where the number means something.
 */
describe("what the aggregator costs (measured)", () => {
  // Fifty milliseconds for ten thousand events, which is five microseconds each. The number is the one this
  // check has always had and ADR 0114 forbids relaxing a threshold on the way out — «un ±30 % que pasa
  // siempre no comprueba nada».
  //
  // It is **not** one of invariant 3's: those live in `packages/bench/src/budget.ts` and are what the agent
  // adds to the application it observes, measured by `make bench`. This is one part of that, bounded on its
  // own so that an accidental O(n²) in `record` shows up as itself rather than as a worse p99.
  it("handles 10 000 events in well under 50 ms", () => {
    const agg = new IntervalAggregator({ now: () => 1_000 });
    const routes = ["/a", "/b/:id", "/c", "/d", "/e"];
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) agg.record("GET", routes[i % 5] ?? "/a", 200 + (i % 3) * 100, (i % 500) / 3);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(agg.rotate()?.endpoints.reduce((t, e) => t + e.count, 0)).toBe(10_000);
  });
});
