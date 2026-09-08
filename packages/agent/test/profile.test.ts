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
