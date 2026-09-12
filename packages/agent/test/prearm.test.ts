import { describe, expect, it } from "vitest";
import { PREARM_MAX_BYTES, PrearmRegister } from "../src/prearm.ts";

const request = (route: string, startedAt: number, durationMs = 10) => ({
  method: "GET",
  route,
  status: 200,
  startedAt,
  durationMs,
  operations: [{ hash: "a", startMs: 1, endMs: 2 }],
  dependencies: [],
});

describe("the prearm reserve", () => {
  // The whole point: the global fine ring has one cursor for every route, so a route's detail disappears under
  // other routes' traffic. An armed route keeps its own, and nobody else's traffic can evict it (ADR 0122).
  it("keeps an armed route's requests whatever else the process is serving", () => {
    const r = new PrearmRegister({ routes: 2, requestsPerRoute: 4 });
    r.arm("GET /cart", 1_000, 60_000);

    for (let i = 0; i < 4; i++) r.observe(request("/cart", 1_100 + i));
    // Traffic from a route nobody armed must not take the armed one's slots.
    for (let i = 0; i < 50; i++) r.observe(request("/other", 1_200 + i));

    expect(r.requestsFor("GET /cart", 1_000).length).toBe(4);
  });

  // In the normal case the reserve holds nothing at all: arming is what fills it, and nothing arms by itself.
  it("holds nothing for a route nobody armed", () => {
    const r = new PrearmRegister();
    r.observe(request("/cart", 1_000));

    expect(r.requestsFor("GET /cart", 0).length).toBe(0);
  });

  // An arm ends on its own. Nothing has to remember to disarm it, and what it held stops being held.
  it("lets an arm expire on its own", () => {
    const r = new PrearmRegister();
    r.arm("GET /cart", 1_000, 5_000);
    r.observe(request("/cart", 1_100));

    expect(r.requestsFor("GET /cart", 6_500).length).toBe(0);
  });

  // Refusing in silence is the failure invariant 14 is about: a route that was not armed has to be counted.
  it("counts the routes it could not arm instead of dropping them quietly", () => {
    const r = new PrearmRegister({ routes: 1 });
    expect(r.arm("GET /cart", 1_000, 60_000)).toBe(true);
    expect(r.arm("GET /checkout", 1_000, 60_000)).toBe(false);

    expect(r.routesDropped).toBe(1);
  });

  // When the instrumentation is already costing too much, the reserve is not an exception: shedding means
  // shedding. Arming must never be a way to push past the budget just as the process is suffering.
  it("writes nothing while fine detail is being shed", () => {
    const r = new PrearmRegister();
    r.arm("GET /cart", 1_000, 60_000);
    r.shed(true);
    r.observe(request("/cart", 1_100));

    expect(r.requestsFor("GET /cart", 1_000).length).toBe(0);
  });

  // Preallocated and bounded by construction, like the other three registers (ADR 0067).
  it("fits its budget with every slot full", () => {
    const r = new PrearmRegister();
    expect(r.bytes()).toBeLessThanOrEqual(PREARM_MAX_BYTES);
    expect(r.bytes()).toBeGreaterThan(0);
  });
});
