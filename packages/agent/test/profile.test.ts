import { AGGREGATES_SCHEMA_V0 } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { OperationWork } from "../src/context.ts";
import { DEFAULT_MAX_OPERATIONS, OTHER_OPERATION, PROFILE_WINDOW_MS, ProfileAggregator } from "../src/profile.ts";

const work = (hash: string, over: Partial<OperationWork> = {}): OperationWork => ({
  kind: "query",
  hash,
  text: `SELECT ${hash} FROM t WHERE id = ?`,
  count: 1,
  totalMs: 1,
  errors: 0,
  ...over,
});

/**
 * The real schema, asked about one operation at a time. The profile is what feeds the batch, so «the schema
 * accepts this» is a claim to check here rather than to write in a comment.
 */
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.compile(AGGREGATES_SCHEMA_V0);
const validateOperation = ajv.getSchema("https://downtrace.io/schema/v0/aggregates.schema.json#/$defs/Operation");
const validateProfile = ajv.getSchema("https://downtrace.io/schema/v0/aggregates.schema.json#/$defs/Profile");
/** The real schema, asked of a window: the one thing a unit test of the aggregator never did. */
const validateProfileWindow = (p: unknown): boolean => validateProfile?.(p) === true;

/** A clock the test drives, so a one-minute window does not take a minute. */
const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("ProfileAggregator", () => {
  it("has nothing to send before its window is up", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/products/:id", [work("a")]);
    expect(profile.rotate()).toBeNull();
    time.advance(PROFILE_WINDOW_MS);
    expect(profile.rotate()).not.toBeNull();
  });

  it("has nothing to send after a quiet minute", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    time.advance(PROFILE_WINDOW_MS);
    expect(profile.rotate()).toBeNull();
  });

  it("adds up what a route did across requests", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/orders/:id", [work("q1", { count: 2, totalMs: 4 })]);
    profile.record("GET", "/orders/:id", [work("q1", { count: 3, totalMs: 6, errors: 1 })]);
    time.advance(PROFILE_WINDOW_MS);
    const rotated = profile.rotate();
    expect(rotated?.endpoints).toHaveLength(1);
    const [endpoint] = rotated?.endpoints ?? [];
    expect(endpoint?.method).toBe("GET");
    expect(endpoint?.route).toBe("/orders/:id");
    expect(endpoint?.operations).toEqual([
      { kind: "query", hash: "q1", text: "SELECT q1 FROM t WHERE id = ?", count: 5, totalMs: 10, errors: 1 },
    ]);
  });

  it("keeps the same query on two routes apart", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    profile.record("POST", "/a", [work("q1")]);
    profile.record("GET", "/b", [work("q1")]);
    time.advance(PROFILE_WINDOW_MS);
    expect(profile.rotate()?.endpoints).toHaveLength(3);
  });

  it("reports the window it covers", () => {
    const time = clock(5_000_000);
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(PROFILE_WINDOW_MS + 500);
    const rotated = profile.rotate();
    expect(rotated?.start).toBe(5_000_000);
    expect(rotated?.durationMs).toBe(PROFILE_WINDOW_MS + 500);
  });

  // gh-610. The agent's clock has decimals (ADR 0131) and the contract's `start` and `durationMs` are integers:
  // a window sealed straight from it is a `400`, and a `400` drops the batch whole, with the intervals riding
  // in it (ADR 0035). This clock used to be `Date.now`, an integer, and that was the only thing keeping the
  // window valid.
  it("reports its window in the integer milliseconds the contract carries, the start rounded down", () => {
    const time = clock(1_789_735_799_454.903);
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(PROFILE_WINDOW_MS + 0.2);
    const rotated = profile.rotate();
    // Down, as every other instant of the batch is rounded (ADR 0145); the duration as the interval's is.
    expect(rotated?.start).toBe(1_789_735_799_454);
    expect(rotated?.durationMs).toBe(PROFILE_WINDOW_MS);
    expect(validateProfileWindow(rotated), JSON.stringify(validateProfile?.errors)).toBe(true);
  });

  it("does the same when it closes because the process is leaving", () => {
    const time = clock(1_789_735_799_454.903);
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(1_234.6);
    const drained = profile.drain();
    expect(drained?.start).toBe(1_789_735_799_454);
    expect(drained?.durationMs).toBe(1_235);
    expect(validateProfileWindow(drained), JSON.stringify(validateProfile?.errors)).toBe(true);
  });

  it("says a millisecond for a window shorter than one, under a clock with decimals too", () => {
    // `durationMs >= 1` in the contract, and rounding is exactly how a real window becomes a zero (gh-392).
    const time = clock(1_000.7);
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(0.2);
    expect(profile.drain()?.durationMs).toBe(1);
  });

  // Rounded on the way out and not on the way in, as the capture's start is (ADR 0145): the window's own start
  // keeps its fraction, or a window that began at .9 of a millisecond would close almost a millisecond early.
  it("decides whether its window is up with the instant it really started at", () => {
    const time = clock(1_000.9);
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(PROFILE_WINDOW_MS - 0.5);
    expect(profile.rotate(), "closed before its window was up").toBeNull();
    time.advance(1);
    expect(profile.rotate()).not.toBeNull();
  });

  it("starts a fresh window after rotating", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(PROFILE_WINDOW_MS);
    profile.rotate();
    time.advance(PROFILE_WINDOW_MS);
    expect(profile.rotate()).toBeNull();
  });
});

describe("ProfileAggregator, when there is more than fits", () => {
  it("keeps the most expensive and says how many it merged", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    const total = DEFAULT_MAX_OPERATIONS + 10;
    for (let i = 0; i < total; i++) {
      profile.record("GET", "/a", [work(`q${i}`, { count: 1, totalMs: i + 1 })]);
    }
    time.advance(PROFILE_WINDOW_MS);
    const [endpoint] = profile.rotate()?.endpoints ?? [];
    const operations = endpoint?.operations ?? [];
    expect(operations).toHaveLength(DEFAULT_MAX_OPERATIONS + 1);

    const bucket = operations.find((o) => o.hash === OTHER_OPERATION);
    expect(bucket?.distinct).toBe(10);
    expect(bucket?.text).toBeUndefined();
    // A cap must not become a lie by omission: nothing executed is missing from the totals.
    expect(operations.reduce((a, o) => a + o.count, 0)).toBe(total);
    expect(operations.reduce((a, o) => a + o.totalMs, 0)).toBe((total * (total + 1)) / 2);
    // The cheapest ten are the ones that went into the bucket.
    expect(bucket?.totalMs).toBe(55);
  });

  it("does not open a bucket when everything fits", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1"), work("q2")]);
    time.advance(PROFILE_WINDOW_MS);
    const [endpoint] = profile.rotate()?.endpoints ?? [];
    expect(endpoint?.operations.some((o) => o.hash === OTHER_OPERATION)).toBe(false);
  });

  // An error is not there to be read, it is an identity nothing else carries (ERR-01), and a reported one
  // takes no time at all — so ordering by time alone made it the first thing merged into a bucket the
  // protocol labels a query, on every route with more than sixty-three distinct operations (ERR-02).
  it("keeps errors ahead of queries when it has to drop something", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    for (let i = 0; i < DEFAULT_MAX_OPERATIONS; i++) {
      profile.record("GET", "/a", [work(`q${i}`, { totalMs: 1000 + i })]);
    }
    // The cheapest thing in the window, and the one that must survive.
    profile.record("GET", "/a", [work("reported", { kind: "explicit", totalMs: 0, errors: 1 })]);
    time.advance(PROFILE_WINDOW_MS);
    const operations = profile.rotate()?.endpoints[0]?.operations ?? [];

    expect(operations.find((o) => o.hash === "reported")?.kind).toBe("explicit");
    expect(operations.find((o) => o.hash === OTHER_OPERATION)?.distinct).toBe(1);
  });

  it("cuts at the same place twice for the same window", () => {
    const rotated = (): string[] => {
      const time = clock();
      const profile = new ProfileAggregator({ now: time.now, maxOperations: 2 });
      // Three queries of the same cost: only the hash can order them, and it has to order them the same way
      // every time or two windows would not be comparable.
      for (const hash of ["q3", "q1", "q2"]) profile.record("GET", "/a", [work(hash, { totalMs: 5 })]);
      time.advance(PROFILE_WINDOW_MS);
      return (profile.rotate()?.endpoints[0]?.operations ?? []).map((o) => o.hash);
    };
    expect(rotated()).toEqual(rotated());
    expect(rotated()).toEqual(["q1", "q2", OTHER_OPERATION]);
  });

  it("folds routes beyond the cap into (other), like the aggregates do", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now, maxRoutes: 2 });
    profile.record("GET", "/a", [work("q1")]);
    profile.record("GET", "/b", [work("q1")]);
    profile.record("GET", "/c", [work("q1")]);
    time.advance(PROFILE_WINDOW_MS);
    const routes = (profile.rotate()?.endpoints ?? []).map((e) => e.route).sort();
    expect(routes).toEqual(["(other)", "/a", "/b"]);
  });
});

// A query the scanner did not understand travels as a hash and a class, never as a label (gh-347, ADR 0085).
// gh-371. A process that lives less than a minute never sent its profile at all: `rotate` looks at the clock
// and says no, and shutting down does not change the clock. The last incomplete minute of **any** process
// went the same way.
describe("ProfileAggregator, when the process is going away", () => {
  it("closes the window whatever the clock says", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(10_000); // ten seconds and the process is gone
    const drained = profile.drain();
    expect(drained?.endpoints[0]?.operations[0]?.hash).toBe("q1");
    // With its real duration: a partial window says how partial it was rather than claiming a minute.
    expect(drained?.durationMs).toBe(10_000);
  });

  it("does not change the ordinary cadence", () => {
    // Draining on every interval would put the profile back on the aggregates' cadence, and that is the
    // arithmetic the ADR 0017 said does not fit.
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(10_000);
    expect(profile.rotate()).toBeNull();
  });

  it("declares a window the contract accepts, even one shorter than a millisecond", () => {
    // The schema says `durationMs >= 1`. A process that observes something and leaves inside the same
    // millisecond used to produce a batch the cloud refuses with a 400 — losing the aggregates with it,
    // and opening a coverage-loss episode over a rounding error (gh-392).
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    const drained = profile.drain();
    expect(drained?.durationMs).toBeGreaterThanOrEqual(1);
    expect(validateProfileWindow(drained)).toBe(true);
  });

  it("has nothing to drain when nothing ran", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    time.advance(10_000);
    expect(profile.drain()).toBeNull();
  });

  it("does not send the same operations twice", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [work("q1")]);
    time.advance(10_000);
    expect(profile.drain()).not.toBeNull();
    expect(profile.drain()).toBeNull();
  });
});

describe("ProfileAggregator, with a query that was not understood", () => {
  const unread = (hash: string) => work(hash, { text: "", class: "select" as const });

  it("sends the class in place of the label", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [unread("q1")]);
    time.advance(PROFILE_WINDOW_MS);
    const operation = profile.rotate()?.endpoints[0]?.operations[0];
    expect(operation?.text).toBeUndefined();
    expect(operation?.class).toBe("select");
    expect(operation?.hash).toBe("q1");
  });

  it("sends neither once the user has turned the text off", () => {
    // Two reasons for one absence, and the protocol carries one. The user's choice is the reason then: the
    // cloud must read «suppressed», which is what they asked for, and not «omitted».
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now, sendText: false });
    profile.record("GET", "/a", [unread("q1")]);
    time.advance(PROFILE_WINDOW_MS);
    const operation = profile.rotate()?.endpoints[0]?.operations[0];
    expect(operation?.text).toBeUndefined();
    expect(operation?.class).toBeUndefined();
  });

  it("produces operations the protocol accepts, labelled or classified", () => {
    const time = clock();
    const profile = new ProfileAggregator({ now: time.now });
    profile.record("GET", "/a", [unread("q1"), work("q2")]);
    time.advance(PROFILE_WINDOW_MS);
    const operations = profile.rotate()?.endpoints[0]?.operations ?? [];
    expect(operations).toHaveLength(2);
    for (const operation of operations) {
      expect(validateOperation?.(operation), ajv.errorsText(validateOperation?.errors)).toBe(true);
    }
  });

  it("would be rejected if it ever sent both, which is why it does not", () => {
    // The exclusion is the schema's, not a convention: a class is the reason there is no text, so the two
    // together are two answers to one question (ADR 0085). Asking it here keeps the rule above honest.
    const both = { kind: "query", hash: "q1", count: 1, totalMs: 1, errors: 0, text: "SELECT ?", class: "select" };
    expect(validateOperation?.(both)).toBe(false);
  });
});

describe("ProfileAggregator, with the text suppressed", () => {
  it("sends everything except the label", () => {
    const time = clock();
    const withText = new ProfileAggregator({ now: time.now });
    const withoutText = new ProfileAggregator({ now: time.now, sendText: false });
    for (const p of [withText, withoutText]) {
      p.record("GET", "/a", [work("q1", { count: 2, totalMs: 3, errors: 1 })]);
      p.record("POST", "/b", [work("q2", { count: 1, totalMs: 9 })]);
    }
    time.advance(PROFILE_WINDOW_MS);
    const bare = withoutText.rotate();
    const labelled = withText.rotate();

    for (const endpoint of bare?.endpoints ?? []) {
      for (const operation of endpoint.operations) expect(operation.text).toBeUndefined();
    }
    // Identical but for the label: suppressing the text keeps the analysis whole (ADR 0017, invariant 5).
    const stripText = (p: typeof labelled) =>
      p?.endpoints.map((e) => ({
        ...e,
        operations: e.operations.map(({ text: _text, ...rest }) => rest),
      }));
    expect(stripText(bare)).toEqual(stripText(labelled));
  });
});

describe("the window a profile stays open", () => {
  const op = (hash: string): OperationWork => ({
    kind: "query",
    hash,
    text: "SELECT 1",
    count: 1,
    totalMs: 1,
    errors: 0,
  });

  // The cadence is production's unless somebody shortened it, and shortening it is the whole point of gh-565:
  // the profile is what the report's diff compares, and two windows that never close inside a test leave the
  // diff out of reach of any end-to-end walk.
  it("rotates on the window it was given and not on the default minute", () => {
    let at = 1_000_000;
    const p = new ProfileAggregator({ now: () => at, windowMs: 2_000 });
    p.record("GET", "/orders", [op("h1")]);

    at += 1_999;
    expect(p.rotate(), "closed before its window was up").toBeNull();
    at += 1;
    const profile = p.rotate();
    expect(profile, "did not close when its window was up").not.toBeNull();
    expect(profile?.endpoints[0]?.route).toBe("/orders");
  });

  // And with nothing said, nothing changes: a minute, which is what ADR 0017 fixed and what production runs on.
  it("is a minute when none is given", () => {
    let at = 1_000_000;
    const p = new ProfileAggregator({ now: () => at });
    p.record("GET", "/orders", [op("h1")]);
    at += PROFILE_WINDOW_MS - 1;
    expect(p.rotate()).toBeNull();
    at += 1;
    expect(p.rotate()).not.toBeNull();
  });
});
