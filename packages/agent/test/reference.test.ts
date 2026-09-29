import { describe, expect, it } from "vitest";
import { FINGERPRINT_LABEL_MAX_LENGTH, labelBytes } from "../src/labels.ts";
import {
  DEFAULT_REFERENCE_DROPPED,
  DEFAULT_REFERENCE_FINGERPRINT_LABELS,
  DEFAULT_REFERENCE_OPERATIONS_PER_SAMPLE,
  DEFAULT_REFERENCE_ROUTES,
  DEFAULT_SAMPLES_PER_ROUTE,
  REFERENCE_MAX_BYTES,
  ReferenceRegister,
} from "../src/reference.ts";
import { MAX_ROUTE_LABEL_LENGTH, MAX_ROUTE_LENGTH, OTHER_ROUTE } from "../src/routes.ts";

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

/** A route template at `MAX_ROUTE_LENGTH`, apart for each `i`: with the longest method, the longest label the table may hold. */
const longestRoute = (i: number) => `/${i}${"r".repeat(MAX_ROUTE_LENGTH - String(i).length - 1)}`;

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
    // Two requests of the endpoint without room: the number it makes is about endpoints, not requests
    // (gh-775), so the case a single request could not tell is told here.
    traffic(r, "/c", [5, 6]);

    const routes = r.snapshot().samples.map((s) => s.route);
    expect(routes.sort()).toEqual(["/a", "/b"]);
    // The third endpoint is not kept, and the register says how many it had to leave out rather than
    // letting the absence pass for «that endpoint had no traffic» (invariant 14) — once per endpoint,
    // no matter how many requests it refused (gh-775).
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

  // The memory half of invariant 3, at the worst case: every slot of every endpoint filled, a route
  // nobody has seen before in every endpoint at the longest label the table may hold, and a fingerprint
  // nobody has seen before, in every operation, at the longest one may be.
  it("holds its memory budget at the worst case of distinct routes and fingerprints", () => {
    const r = new ReferenceRegister({ random: () => 0 });
    for (let i = 0; i < DEFAULT_REFERENCE_ROUTES; i += 1) {
      for (let n = 0; n < DEFAULT_SAMPLES_PER_ROUTE; n += 1) {
        // A route at the longest label the table may hold, since gh-859 the route table is in the count:
        // a worst case that left it out would hold a reserve the register does not really hold.
        r.consider(
          "OPTIONS",
          `/${i}${"r".repeat(MAX_ROUTE_LENGTH - String(i).length - 1)}`,
          200,
          1_000 + i * 10 + n,
          5,
          () =>
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

describe("the route table of the reference", () => {
  // gh-859. The route table was the last table the arithmetic left out: `bytes()` and `reservedBytes()`
  // counted the arrays and the fingerprint table, and the labels of the routes — up to
  // `MAX_ROUTE_LABEL_LENGTH` each — were not in the number, so the worst case the register may hold passed
  // `REFERENCE_MAX_BYTES` while the tests held the line. The arithmetic counts everything the register
  // keeps, or the budget is not one (ADR 0067).

  it("reserves its worst case, computed from the constants", () => {
    const r = new ReferenceRegister();
    // What the register holds before traffic names anything — the arrays, preallocated, and the sentinel
    // its fingerprint table starts with — plus each table at its room with every label at its longest. The
    // worst case from the constants the register is built from: computed, not copied (ADR 0067).
    const worst =
      r.bytes() +
      DEFAULT_REFERENCE_FINGERPRINT_LABELS * labelBytes(FINGERPRINT_LABEL_MAX_LENGTH) +
      DEFAULT_REFERENCE_ROUTES * labelBytes(MAX_ROUTE_LABEL_LENGTH);
    expect(r.reservedBytes()).toBe(worst);
    expect(worst).toBeLessThanOrEqual(REFERENCE_MAX_BYTES);
  });

  it("counts the route table it interns, the way it counts the fingerprints", () => {
    const r = new ReferenceRegister();
    const empty = r.bytes();
    r.consider("OPTIONS", longestRoute(0), 200, 1_000, 5, noOperations);
    // A new route costs its label, by the same arithmetic the reserve uses (labels.ts): the table is part
    // of what the register holds, the way gh-805 made the fingerprint table part of the arithmetic.
    expect(r.bytes()).toBe(empty + labelBytes(MAX_ROUTE_LABEL_LENGTH));
    // The same traffic on a route it already keeps costs nothing: the table interns, it does not append.
    r.consider("OPTIONS", longestRoute(0), 200, 2_000, 5, noOperations);
    expect(r.bytes()).toBe(empty + labelBytes(MAX_ROUTE_LABEL_LENGTH));
  });

  it("does not count a route it had no room for, and says it dropped it", () => {
    const r = new ReferenceRegister();
    for (let i = 0; i < DEFAULT_REFERENCE_ROUTES; i += 1)
      r.consider("OPTIONS", longestRoute(i), 200, 1_000 + i, 5, noOperations);
    const at = r.bytes();
    r.consider("OPTIONS", longestRoute(16), 200, 2_000, 5, noOperations);
    // Past the cap the traffic costs nothing — a register that still grew here was the bug (invariant 3) —
    // and the loss is said, not silent (invariant 14).
    expect(r.bytes()).toBe(at);
    expect(r.snapshot().routesDropped).toBe(1);
  });
});

describe("the dropped table of the reference", () => {
  // gh-775. The register counted the requests it refused, so one endpoint with no room and a thousand
  // requests published as a thousand endpoints without samples, while the schema of the evidence said the
  // number was endpoints. Now it counts endpoints, the way the coarse register counts its dropped routes:
  // once each, remembered by a 32-bit summary of the label — no text (invariant 5) — in a table
  // preallocated to `DEFAULT_REFERENCE_DROPPED`, the same 256 as the coarse register's `DEFAULT_DROPPED`.
  // When the table is full, or two endpoints share a summary, the number stops and is a lower bound
  // (invariant 14 says the loss is spoken of; invariant 3 says the memory does not grow).

  it("counts an endpoint it had no room for once, no matter how many requests it gets", () => {
    const r = new ReferenceRegister({ routes: 2, samplesPerRoute: 1 });
    traffic(r, "/a", [1]);
    traffic(r, "/b", [2]);
    // A third endpoint with a thousand requests: one endpoint without room, not a thousand (gh-775).
    for (let i = 0; i < 1_000; i += 1) r.consider("GET", "/c", 200, 1_000 + i, 5, noOperations);
    expect(r.snapshot().routesDropped).toBe(1);
    // A fourth endpoint without room, with two requests: the next one, and only the next one.
    traffic(r, "/d", [7, 8]);
    expect(r.snapshot().routesDropped).toBe(2);
  });

  it("stops counting when the table of summaries is full, and keeps its memory", () => {
    const r = new ReferenceRegister({ routes: 2, samplesPerRoute: 1 });
    traffic(r, "/a", [1]);
    traffic(r, "/b", [2]);
    for (let i = 0; i < DEFAULT_REFERENCE_DROPPED; i += 1) r.consider("GET", `/d${i}`, 200, 1_000 + i, 5, noOperations);
    expect(r.snapshot().routesDropped).toBe(DEFAULT_REFERENCE_DROPPED);
    const at = r.bytes();
    // Past the cap the traffic costs nothing — a register that still grew here was the bug (invariant 3) —
    // and the count stays where it is: a lower bound, not a count (invariant 14).
    for (let i = DEFAULT_REFERENCE_DROPPED; i < DEFAULT_REFERENCE_DROPPED + 100; i += 1)
      r.consider("GET", `/d${i}`, 200, 2_000 + i, 5, noOperations);
    expect(r.snapshot().routesDropped).toBe(DEFAULT_REFERENCE_DROPPED);
    expect(r.bytes()).toBe(at);
  });

  it("holds its memory budget with the dropped table at its cap", () => {
    const r = new ReferenceRegister({ random: () => 0 });
    for (let i = 0; i < DEFAULT_REFERENCE_ROUTES; i += 1)
      r.consider("OPTIONS", longestRoute(i), 200, 1_000 + i, 5, noOperations);
    // Every slot of the dropped table taken, with the longest label it may hold in the route table beside
    // it: the worst case the register may hold, with the table that gh-775 put in the count at its cap.
    for (let i = 0; i < DEFAULT_REFERENCE_DROPPED; i += 1)
      r.consider("OPTIONS", longestRoute(DEFAULT_REFERENCE_ROUTES + i), 200, 2_000 + i, 5, noOperations);
    expect(r.snapshot().routesDropped).toBe(DEFAULT_REFERENCE_DROPPED);
    expect(r.bytes()).toBeLessThanOrEqual(REFERENCE_MAX_BYTES);
  });
});
