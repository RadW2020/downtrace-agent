import { describe, expect, it } from "vitest";
import { Captures, type LiveCapture, MAX_LIVE_CAPTURES, sliceFor } from "../src/captures.ts";
import { dependencyKey } from "../src/context.ts";
import type { FineRequest, FineSnapshot } from "../src/fine.ts";
import type { PendingCapture } from "../src/transport.ts";

const order = (id: string, over: Partial<PendingCapture> = {}): PendingCapture => ({
  id,
  windowSeconds: 60,
  expiresAt: 10_000_000,
  ...over,
});

/**
 * CAP-01, from the side that had no code: the cloud asks, this obeys, and the three moments stay apart —
 * accepted, really observing, and finished (gh-379).
 */
describe("Captures", () => {
  it("starts watching what it was asked for, and says so once", () => {
    const c = new Captures();
    c.accept([order("cap-1")], 1_000);
    expect(c.size).toBe(1);
    expect(c.toReport()).toEqual([{ id: "cap-1", startedAt: 1_000 }]);
    c.reported(["cap-1"]);
    // Said once: the answer keeps repeating the order until the cloud sees the start, and repeating it back
    // every second would be one row of noise per interval.
    expect(c.toReport()).toEqual([]);
  });

  it("does not start the same capture twice", () => {
    const c = new Captures();
    c.accept([order("cap-1")], 1_000);
    c.accept([order("cap-1")], 5_000);
    expect(c.size).toBe(1);
    expect(c.toReport()[0]?.startedAt).toBe(1_000);
  });

  it("does not start one the cloud has stopped waiting for", () => {
    const c = new Captures();
    c.accept([order("stale", { expiresAt: 900 })], 1_000);
    expect(c.size).toBe(0);
  });

  it("holds no more than it said it would", () => {
    const c = new Captures();
    c.accept(
      Array.from({ length: MAX_LIVE_CAPTURES + 3 }, (_, i) => order(`cap-${i}`)),
      1_000,
    );
    expect(c.size).toBe(MAX_LIVE_CAPTURES);
  });

  it("hands over a capture when its window closes, and only once", () => {
    const c = new Captures();
    c.accept([order("cap-1", { windowSeconds: 10 })], 1_000);
    expect(c.take(5_000)).toEqual([]);
    const done = c.take(11_000);
    expect(done.map((d) => d.id)).toEqual(["cap-1"]);
    expect(c.take(20_000)).toEqual([]);
    expect(c.size).toBe(0);
  });

  it("hands over everything when the process is leaving", () => {
    // Partial evidence is an answer; silence is not. The same reasoning as the profile (gh-371).
    const c = new Captures();
    c.accept([order("cap-1"), order("cap-2")], 1_000);
    expect(
      c
        .takeAll()
        .map((d) => d.id)
        .sort(),
    ).toEqual(["cap-1", "cap-2"]);
    expect(c.size).toBe(0);
  });
});

describe("what one capture saw", () => {
  const request = (startedAt: number, over: Partial<FineRequest> = {}): FineRequest => ({
    method: "GET",
    route: "/orders",
    status: 200,
    startedAt,
    durationMs: 5,
    operations: [],
    dependencies: [],
    truncated: false,
    detailLost: false,
    ...over,
  });
  const snapshot = (requests: FineRequest[], over: Partial<FineSnapshot["coverage"]> = {}): FineSnapshot => ({
    requests,
    coverage: {
      requestCapacity: 10,
      operationCapacity: 10,
      requests: requests.length,
      detailLost: requests.filter((r) => r.detailLost).length,
      truncated: requests.filter((r) => r.truncated).length,
      ...over,
    },
  });
  const live = (over: Partial<LiveCapture> = {}): LiveCapture => ({
    id: "c",
    startedAt: 1_000,
    endsAt: 2_000,
    reported: true,
    footprint: {},
    ...over,
  });

  it("counts the two coverages apart, and never their total", () => {
    // `product.md:192`: what was observed from the effective start, and what was attached from detail that
    // was already being kept. One number would hide that half of it is older than the capture.
    const slice = sliceFor(
      live(),
      snapshot([
        request(500, { detailLost: true }),
        request(900, { detailLost: true, truncated: true }),
        request(1_000),
        request(1_500),
      ]),
    );
    expect(slice.observedRequests).toBe(2);
    expect(slice.attachedRequests).toBe(2);
    expect(slice.detailLost).toBe(2);
    expect(slice.truncated).toBe(1);
  });

  it("is an answer even when nothing ran", () => {
    // «Una captura sin requests no prueba recuperación» (CAP-01): empty evidence is a result, silence is not.
    const slice = sliceFor(live(), snapshot([]));
    expect(slice.requests).toEqual([]);
    expect(slice.observedRequests).toBe(0);
    expect(slice.attachedRequests).toBe(0);
  });

  // gh-397. The order says what to watch and this used to hand over the whole register: a capture of one
  // route arrived carrying the name, the timing and the composition of every other route in the service,
  // and the two coverages counted all of it.
  //
  // covers: ESC-08
  it("hands over the route it was asked for, and counts only that one", () => {
    const slice = sliceFor(
      live({ footprint: { method: "GET", route: "/orders" } }),
      snapshot([
        request(900, { route: "/products" }),
        request(950),
        request(1_100),
        request(1_200, { route: "/products" }),
        request(1_300, { method: "POST" }),
      ]),
    );
    expect(slice.requests.map((r) => `${r.method} ${r.route}`)).toEqual(["GET /orders", "GET /orders"]);
    expect([slice.observedRequests, slice.attachedRequests]).toEqual([1, 1]);
  });

  it("matches the route alone when the order does not name a method", () => {
    const slice = sliceFor(
      live({ footprint: { route: "/orders" } }),
      snapshot([request(1_100), request(1_200, { method: "POST" }), request(1_300, { route: "/products" })]),
    );
    expect(slice.requests).toHaveLength(2);
  });

  it("hands over the requests that used the dependency it was asked about", () => {
    const slice = sliceFor(
      live({ footprint: { kind: "postgres", target: "db:5432" } }),
      snapshot([
        request(1_100, { dependencies: [dependencyKey("redis", "cache:6379")] }),
        request(1_200, { dependencies: [dependencyKey("postgres", "db:5432"), dependencyKey("redis", "cache:6379")] }),
        request(1_300, { dependencies: [] }),
      ]),
    );
    expect(slice.requests.map((r) => r.startedAt)).toEqual([1_200]);
  });

  it("keeps a request whose dependency list did not fit, because a gap is not a proof", () => {
    // Invariant 14 in its smallest form: the register keeps up to eight dependencies per request, and a
    // request that touched more cannot be shown **not** to have used the ninth.
    const slice = sliceFor(
      live({ footprint: { kind: "http", target: "provider:443" } }),
      snapshot([
        request(1_100, { dependencies: [dependencyKey("redis", "cache:6379")] }),
        request(1_200, { dependencies: [dependencyKey("redis", "cache:6379")], dependenciesTruncated: true }),
      ]),
    );
    expect(slice.requests.map((r) => r.startedAt)).toEqual([1_200]);
  });

  it("hands over everything when the order names neither a route nor a dependency", () => {
    const slice = sliceFor(
      live({ footprint: { environment: "production" } }),
      snapshot([request(1_100), request(1_200, { route: "/products" })]),
    );
    expect(slice.requests).toHaveLength(2);
  });
});
