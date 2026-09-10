import { describe, expect, it } from "vitest";
import { Captures, MAX_LIVE_CAPTURES, sliceFor } from "../src/captures.ts";
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
  const request = (startedAt: number): FineRequest => ({
    method: "GET",
    route: "/orders",
    status: 200,
    startedAt,
    durationMs: 5,
    operations: [],
    truncated: false,
    detailLost: false,
  });
  const snapshot = (starts: number[]): FineSnapshot => ({
    requests: starts.map(request),
    coverage: { requestCapacity: 10, operationCapacity: 10, requests: starts.length, detailLost: 2, truncated: 1 },
  });

  it("counts the two coverages apart, and never their total", () => {
    // `product.md:192`: what was observed from the effective start, and what was attached from detail that
    // was already being kept. One number would hide that half of it is older than the capture.
    const slice = sliceFor(
      { id: "c", startedAt: 1_000, endsAt: 2_000, reported: true },
      snapshot([500, 900, 1_000, 1_500]),
    );
    expect(slice.observedRequests).toBe(2);
    expect(slice.attachedRequests).toBe(2);
    expect(slice.detailLost).toBe(2);
    expect(slice.truncated).toBe(1);
  });

  it("is an answer even when nothing ran", () => {
    // «Una captura sin requests no prueba recuperación» (CAP-01): empty evidence is a result, silence is not.
    const slice = sliceFor({ id: "c", startedAt: 1_000, endsAt: 2_000, reported: true }, snapshot([]));
    expect(slice.requests).toEqual([]);
    expect(slice.observedRequests).toBe(0);
    expect(slice.attachedRequests).toBe(0);
  });
});
