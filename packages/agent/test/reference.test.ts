import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE,
  DEFAULT_REFERENCE_ROUTES,
  DEFAULT_SAMPLES_PER_ROUTE,
  REFERENCE_MAX_BYTES,
  ReferenceRegister,
} from "../src/reference.ts";
import { OTHER_ROUTE } from "../src/routes.ts";

/**
 * The third register of the black box: a few requests per endpoint, kept so that a capture has something
 * to compare its bad ones against. `product.md:100`.
 *
 * What these tests protect is the selection. Keeping the fastest requests would bias every later
 * comparison — any degradation would look worse than it is — and keeping the last ones is cheap and can
 * land on a strange moment. The criterion is uniform, and it is published with the samples.
 */

const noOperations = () => [];

function traffic(r: ReferenceRegister, route: string, durations: number[]): void {
  for (const [i, ms] of durations.entries()) {
    r.consider("GET", route, 200, 1_000 + i, ms, noOperations);
  }
}

describe("the reference samples", () => {
  it("keeps a bounded number per endpoint and tells the population it drew from", () => {
    const r = new ReferenceRegister({ samplesPerRoute: 3 });
    traffic(
      r,
      "/orders",
      Array.from({ length: 100 }, (_, i) => i),
    );

    const snapshot = r.snapshot();
    expect(snapshot.samples).toHaveLength(3);
    expect(snapshot.population).toBe(100);
    expect(snapshot.selection).toBe("uniform-reservoir");
    expect(snapshot.renewalPaused).toBe(false);
  });

  // The trap the whole register exists to avoid. With a skewed population — nine fast requests for every
  // slow one — a uniform sample is slow about a tenth of the time, and «the fastest N» never is.
  it("does not keep the fastest: with a skewed distribution it looks like the population", () => {
    const runs = 400;
    let slowKept = 0;
    let kept = 0;
    for (let run = 0; run < runs; run += 1) {
      const r = new ReferenceRegister({ samplesPerRoute: 3 });
      // 90 requests of 5 ms and 10 of 500 ms, interleaved so position cannot stand in for duration.
      const durations: number[] = [];
      for (let i = 0; i < 100; i += 1) durations.push(i % 10 === 0 ? 500 : 5);
      traffic(r, "/orders", durations);
      for (const s of r.snapshot().samples) {
        kept += 1;
        if (s.durationMs === 500) slowKept += 1;
      }
    }
    const share = slowKept / kept;
    // The population is 10 % slow. Uniform sampling lands near that; «the fastest» lands on zero and
    // «the last N» on whatever the tail happened to be.
    expect(share, `slow share was ${share}`).toBeGreaterThan(0.05);
    expect(share, `slow share was ${share}`).toBeLessThan(0.16);
  });

  it("keeps every endpoint apart, up to the number it said it would", () => {
    const r = new ReferenceRegister({ routes: 2, samplesPerRoute: 1 });
    traffic(r, "/a", [1, 2, 3]);
    traffic(r, "/b", [4]);
    traffic(r, "/c", [5]);

    const routes = r.snapshot().samples.map((s) => s.route);
    expect(routes.sort()).toEqual(["/a", "/b"]);
    // The third endpoint is not kept, and the register says how many it had to leave out rather than
    // letting the absence pass for «that endpoint had no traffic» (invariant 14).
    expect(r.snapshot().routesDropped).toBe(1);
  });

  it("stops renewing while it is paused, and says that it did", () => {
    // REF-01 as close as an instrumentation can get: it does not know whether an incident is open —the
    // cloud does— but it knows detail has been asked of it, which is when something is happening.
    const r = new ReferenceRegister({ samplesPerRoute: 1 });
    r.consider("GET", "/orders", 200, 1_000, 5, noOperations);
    r.pause();
    for (let i = 0; i < 50; i += 1) r.consider("GET", "/orders", 500, 2_000 + i, 900, noOperations);

    const snapshot = r.snapshot();
    expect(snapshot.samples).toHaveLength(1);
    expect(snapshot.samples[0]?.durationMs).toBe(5);
    expect(snapshot.renewalPaused).toBe(true);
    // And the population does not grow with what it refused to look at: it says what it drew from.
    expect(snapshot.population).toBe(1);

    r.resume();
    r.consider("GET", "/orders", 200, 3_000, 7, noOperations);
    expect(r.snapshot().population).toBe(2);
    // Once it has paused, it keeps saying so: the samples in hand are older than the traffic.
    expect(r.snapshot().renewalPaused).toBe(true);
  });

  it("keeps the operations of a sample, in order, and only asks for them when it takes one", () => {
    let asked = 0;
    const operations = () => {
      asked += 1;
      return [
        { hash: "aaa", startMs: 0, endMs: 5 },
        { hash: "bbb", startMs: 5, endMs: 9 },
      ];
    };
    const r = new ReferenceRegister({ samplesPerRoute: 1 });
    r.consider("GET", "/orders", 200, 1_000, 10, operations);
    // Not once per request: the copy costs, and it only happens when the sample is admitted.
    for (let i = 0; i < 200; i += 1) r.consider("GET", "/orders", 200, 2_000 + i, 10, () => []);

    const sample = r.snapshot().samples[0];
    expect(sample).toBeDefined();
    expect(asked).toBe(1);
    if (sample?.startedAt === 1_000) {
      expect(sample.operations).toEqual([
        { hash: "aaa", startMs: 0, endMs: 5 },
        { hash: "bbb", startMs: 5, endMs: 9 },
      ]);
    }
  });

  it("truncates a sample that ran more operations than it keeps, and says so", () => {
    const many = Array.from({ length: DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE + 5 }, (_, i) => ({
      hash: `h${i}`,
      startMs: i,
      endMs: i + 1,
    }));
    const r = new ReferenceRegister({ samplesPerRoute: 1 });
    r.consider("GET", "/orders", 200, 1_000, 10, () => many);

    const sample = r.snapshot().samples[0];
    expect(sample?.operations).toHaveLength(DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE);
    expect(sample?.truncated).toBe(true);
  });

  // The memory half of invariant 3, asserted rather than promised, like the other two registers.
  it("stays inside its memory budget", () => {
    const r = new ReferenceRegister();
    // Every slot of every endpoint full, and more endpoints offered than it keeps.
    for (let i = 0; i < DEFAULT_REFERENCE_ROUTES * 4; i += 1) {
      for (let n = 0; n < DEFAULT_SAMPLES_PER_ROUTE; n += 1) {
        r.consider("GET", `/route-${i}`, 200, 1_000 + i, 5, () => [{ hash: "a", startMs: 0, endMs: 1 }]);
      }
    }
    expect(r.bytes()).toBeLessThanOrEqual(REFERENCE_MAX_BYTES);
    // And it is not passing because the register is empty.
    expect(DEFAULT_REFERENCE_ROUTES).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_SAMPLES_PER_ROUTE).toBeGreaterThanOrEqual(2);
    expect(r.snapshot().samples.length).toBe(DEFAULT_REFERENCE_ROUTES * DEFAULT_SAMPLES_PER_ROUTE);
  });

  it("does not grow with traffic", () => {
    const r = new ReferenceRegister();
    // The first sample interns the route and its fingerprint; the traffic after it — the same names over and
    // over — must not (the same shape as the fine register's test, gh-765).
    r.consider("GET", "/orders", 200, 1_000, 5, () => [{ hash: "a", startMs: 0, endMs: 1 }]);
    const before = r.bytes();
    for (let i = 1; i < 5_000; i += 1) {
      r.consider("GET", "/orders", 200, 1_000 + i, 5, () => [{ hash: "a", startMs: 0, endMs: 1 }]);
    }
    expect(r.bytes()).toBe(before);
  });

  it("is an answer when nothing has run", () => {
    const snapshot = new ReferenceRegister().snapshot();
    expect(snapshot.samples).toEqual([]);
    expect(snapshot.population).toBe(0);
    // The selection is what it is even with nothing selected: it is how the register works, not a
    // description of this particular answer.
    expect(snapshot.selection).toBe("uniform-reservoir");
  });
});

describe("the label tables of the reference", () => {
  // gh-805, the younger brother of gh-765. The route table is bounded by `routeCapacity`, but the
  // fingerprints its samples intern were not: a new query fingerprint on every admitted sample added one
  // for the life of the process, and `bytes()` did not count the table, so neither the budget nor the
  // tripwire could see the growth. `random: () => 0` admits every request, which is what keeps the test
  // from being about the selection.

  const ops = (i: number) => () => [{ hash: String(i).padStart(16, "0"), startMs: 0, endMs: 1 }];

  it("counts the fingerprints it interns, and stops growing at the cap", () => {
    const r = new ReferenceRegister({ samplesPerRoute: 2, random: () => 0 });
    const empty = r.bytes();
    r.consider("GET", "/orders", 200, 1_000, 5, ops(0));
    // A new name costs memory: the table is part of what the register holds, the way gh-765 made the
    // fine register's tables part of its arithmetic.
    expect(r.bytes()).toBeGreaterThan(empty);
    // Past the cap the traffic costs nothing: a register that still grew here was the bug (invariant 3).
    for (let i = 1; i < 500; i += 1) r.consider("GET", "/orders", 200, 1_000 + i, 5, ops(i));
    const at = r.bytes();
    for (let i = 500; i < 1_000; i += 1) r.consider("GET", "/orders", 200, 1_000 + i, 5, ops(i));
    expect(r.bytes()).toBe(at);
  });

  it("folds a fingerprint into (other) once the table is full, and says it did", () => {
    const r = new ReferenceRegister({ samplesPerRoute: 1, fingerprintLabels: 2, random: () => 0 });
    r.consider("GET", "/orders", 200, 1_000, 5, () => [
      { hash: "aaaaaaaaaaaaaaaa", startMs: 0, endMs: 1 },
      { hash: "bbbbbbbbbbbbbbbb", startMs: 1, endMs: 2 },
    ]);
    // The next admitted sample replaces it, and neither of its fingerprints fits.
    r.consider("GET", "/orders", 200, 2_000, 5, () => [
      { hash: "cccccccccccccccc", startMs: 0, endMs: 1 },
      { hash: "dddddddddddddddd", startMs: 1, endMs: 2 },
    ]);

    const snapshot = r.snapshot();
    expect(snapshot.samples).toHaveLength(1);
    // The sample stays true and what is lost is the name, the same fold the fine register makes (COB-01).
    expect(snapshot.samples[0]?.operations.map((o) => o.hash)).toEqual([OTHER_ROUTE, OTHER_ROUTE]);
    expect(snapshot.labelsFolded).toBe(2);
  });

  // The memory half of invariant 3, at the worst case this ticket is about: every slot of every endpoint
  // filled, and a fingerprint nobody has seen before, in every operation, at the longest one may be.
  it("holds its memory budget at the worst case of distinct fingerprints", () => {
    const r = new ReferenceRegister({ random: () => 0 });
    for (let i = 0; i < DEFAULT_REFERENCE_ROUTES; i += 1) {
      for (let n = 0; n < DEFAULT_SAMPLES_PER_ROUTE; n += 1) {
        r.consider("GET", `/route-${i}`, 200, 1_000 + i * 10 + n, 5, () =>
          Array.from({ length: DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE }, (_, j) => ({
            hash: String(i * 100 + n * 10 + j).padStart(16, "0"),
            startMs: j,
            endMs: j + 1,
          })),
        );
      }
    }

    // Every table is at its cap with every label at its longest, so the register holds its reserve
    // exactly — a number, not a promise — and the reserve fits the budget the arithmetic is for (ADR 0067).
    expect(r.bytes()).toBe(r.reservedBytes());
    expect(r.bytes()).toBeLessThanOrEqual(REFERENCE_MAX_BYTES);
  });
});
