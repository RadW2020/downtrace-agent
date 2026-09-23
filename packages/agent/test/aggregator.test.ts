import { LATENCY_BUCKETS_V0 } from "@downtrace/protocol";
import { describe, expect, it } from "vitest";
import { IntervalAggregator } from "../src/aggregator.ts";
import { OTHER_ROUTE } from "../src/routes.ts";

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** A clock that does not move: these are about what is counted, not about when. */
const still = () => 1_000;

/** Narrows an optional value in tests, failing loudly instead of asserting with `!`. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

describe("IntervalAggregator", () => {
  it("counts requests, status classes, errors and latency per route", () => {
    let t = 1_000;
    const agg = new IntervalAggregator({ maxRoutes: 500, now: () => t });
    agg.record("GET", "/products", 200, 3.2);
    agg.record("GET", "/products", 200, 4.8);
    agg.record("GET", "/products", 404, 1.1);
    agg.record("GET", "/products", 503, 950);
    agg.record("POST", "/checkout", 201, 350);
    t = 11_000;
    const interval = agg.rotate();
    expect(interval).not.toBeNull();
    expect(interval?.start).toBe(1_000);
    expect(interval?.durationMs).toBe(10_000);
    const products = interval?.endpoints.find((e) => e.route === "/products");
    expect(products).toMatchObject({
      method: "GET",
      count: 4,
      errors: 1,
      status: { success: 2, redirect: 0, clientError: 1, serverError: 1 },
    });
    expect(products?.latency.counts).toHaveLength(LATENCY_BUCKETS_V0);
    expect(sum(products?.latency.counts ?? [])).toBe(4);
    expect(products?.latency.max).toBe(950);
    expect(products?.latency.sum).toBeCloseTo(959.1, 3);
    const checkout = interval?.endpoints.find((e) => e.route === "/checkout");
    expect(checkout?.latency.counts[19]).toBe(1); // 350 ms → (300, 400]
  });

  // gh-610. The agent hands this its own clock now, which has decimals (ADR 0131), and the contract's `start`
  // and `durationMs` do not. This was always rounded where the interval is built, which is why wiring the clock
  // changes nothing in what it sends — and why it is worth a line that says so.
  it("reports its interval in integer milliseconds under a clock with decimals, the start rounded down", () => {
    let t = 1_789_735_799_454.903;
    const agg = new IntervalAggregator({ now: () => t });
    agg.record("GET", "/a", 200, 1);
    t += 10_000.4;
    const interval = must(agg.rotate(), "interval");
    expect(interval.start).toBe(1_789_735_799_454);
    expect(interval.durationMs).toBe(10_000);
  });

  it("returns null and resets when nothing was recorded", () => {
    const agg = new IntervalAggregator({ now: still });
    expect(agg.rotate()).toBeNull();
    agg.record("GET", "/a", 200, 1);
    expect(agg.rotate()?.endpoints).toHaveLength(1);
    expect(agg.rotate()).toBeNull();
  });

  it("caps distinct routes per interval and folds the rest into (other)", () => {
    const agg = new IntervalAggregator({ maxRoutes: 500, now: still });
    for (let i = 0; i < 600; i++) agg.record("GET", `/scan/${i}`, 404, 0.5);
    const interval = agg.rotate();
    expect(interval?.endpoints).toHaveLength(501);
    const other = interval?.endpoints.at(-1);
    expect(other?.route).toBe(OTHER_ROUTE);
    expect(other?.count).toBe(100);
    expect(sum(interval?.endpoints.map((e) => e.count) ?? [])).toBe(600);
  });

  // The half of this that is about the code. What it used to also assert — that ten thousand events take less
  // than 50 ms — is a measurement, so it moved to `aggregator.measure.test.ts` whole and with its number
  // (ADR 0114, gh-562). Splitting the file costs one file and loses no check.
  it("counts ten thousand events into the endpoints they belong to", () => {
    const agg = new IntervalAggregator({ now: still });
    const routes = ["/a", "/b/:id", "/c", "/d", "/e"];
    for (let i = 0; i < 10_000; i++) agg.record("GET", routes[i % 5] ?? "/a", 200 + (i % 3) * 100, (i % 500) / 3);
    const interval = must(agg.rotate(), "interval");
    expect(interval.endpoints).toHaveLength(routes.length);
    expect(sum(interval.endpoints.map((e) => e.count))).toBe(10_000);
    // Evenly, which is what says they went to the right one and not all to the first.
    for (const e of interval.endpoints) expect(e.count).toBe(2_000);
  });
});

/** One request's work against one dependency, in the shape the recorder takes. */
function work(calls: number, ms: number, maxMs = ms, kind: "postgres" | "redis" | "http" = "postgres", target = "") {
  const key = target === "" ? kind : `${kind} ${target}`;
  return new Map([[key, { kind, target, calls, ms, maxMs, errors: 0, waitMs: 0 }]]);
}

describe("dependencies", () => {
  it("bins each request by how many calls it made, and sums their time", () => {
    const agg = new IntervalAggregator({ now: still });
    agg.record("POST", "/checkout", 201, 5, work(12, 20, 9));
    agg.record("POST", "/checkout", 201, 6, work(14, 22, 11));
    agg.record("POST", "/checkout", 201, 4, work(2, 3, 2));
    const interval = must(agg.rotate(), "interval");
    const deps = must(interval.endpoints[0]?.dependencies, "dependencies");
    expect(deps).toHaveLength(1);
    const pg = must(deps[0], "postgres dependency");
    expect(pg.kind).toBe("postgres");
    expect(pg.target).toBe("");
    expect(pg.callsPerRequest[2]).toBe(1); // the 2-call request
    expect(pg.callsPerRequest[5]).toBe(2); // both in the 11–20 bucket
    expect(pg.totalMs).toBe(45);
    expect(pg.max).toBe(11);
  });

  it("keeps one entry per kind and target, so many hosts do not collapse into one", () => {
    const agg = new IntervalAggregator({ now: still });
    const mixed = new Map([
      ["postgres", { kind: "postgres" as const, target: "", calls: 3, ms: 9, maxMs: 4, errors: 0, waitMs: 12 }],
      [
        "http api.stripe.com",
        { kind: "http" as const, target: "api.stripe.com", calls: 2, ms: 300, maxMs: 200, errors: 1, waitMs: 0 },
      ],
      [
        "http api.other.com",
        { kind: "http" as const, target: "api.other.com", calls: 1, ms: 40, maxMs: 40, errors: 0, waitMs: 0 },
      ],
    ]);
    agg.record("POST", "/checkout", 201, 5, mixed);
    const interval = must(agg.rotate(), "interval");
    const deps = must(interval.endpoints[0]?.dependencies, "dependencies");
    expect(deps).toHaveLength(3);
    const stripe = must(
      deps.find((d) => d.target === "api.stripe.com"),
      "stripe dependency",
    );
    expect(stripe.errors).toBe(1);
    expect(stripe.max).toBe(200);
    // Waiting is only sent when there was some: the driver that reported none omits the field entirely.
    expect(stripe.waitMs).toBeUndefined();
    expect(
      must(
        deps.find((d) => d.kind === "postgres"),
        "postgres",
      ).waitMs,
    ).toBe(12);
  });

  it("omits the field entirely for endpoints where no call was observed", () => {
    const agg = new IntervalAggregator({ now: still });
    agg.record("GET", "/healthz", 200, 1);
    const interval = must(agg.rotate(), "interval");
    expect(interval.endpoints[0]?.dependencies).toBeUndefined();
  });

  it("an N+1 moves the histogram to a higher bucket", () => {
    const normal = new IntervalAggregator({ now: still });
    const broken = new IntervalAggregator({ now: still });
    for (let i = 0; i < 10; i++) {
      normal.record("GET", "/products", 200, 5, work(2, 4, 3));
      broken.record("GET", "/products", 200, 40, work(53, 80, 4));
    }
    const bucketOf = (agg: IntervalAggregator) => {
      const deps = must(must(agg.rotate(), "interval").endpoints[0]?.dependencies, "dependencies");
      return must(deps[0], "dependency").callsPerRequest.findIndex((c) => c > 0);
    };
    expect(bucketOf(broken)).toBeGreaterThan(bucketOf(normal));
  });
});
