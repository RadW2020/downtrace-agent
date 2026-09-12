import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { sliceFor } from "../src/captures.ts";
import type { AgentConfig } from "../src/config.ts";
import { currentContext, dependencyKey, recordCall, recordOperationIn } from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";
import { PrearmRegister } from "../src/prearm.ts";

/**
 * The wire between the two halves of prearming, which was cut.
 *
 * Arming worked, the reserve took rows, and `sliceFor` knew how to merge them — each with a green test. What
 * nothing checked is that the rows carried any detail and that anybody ever read them: `observe` was fed
 * `operations: []` and the one production call to `sliceFor` never passed its fourth argument. A whole
 * published capability did nothing, and no unit test could see it because every unit was fine (gh-498).
 *
 * These walk the register's own API end to end, which is the shape the agent uses.
 */
describe("the prearmed reserve carries what a capture needs", () => {
  it("keeps the operations and the pool wait of the requests it takes", () => {
    const prearm = new PrearmRegister();
    prearm.arm("GET /cart", 1_000, 60_000);
    prearm.observe({
      method: "GET",
      route: "/cart",
      status: 200,
      startedAt: 1_100,
      durationMs: 42,
      poolWaitMs: 7,
      operations: [{ hash: "abc", startMs: 1, endMs: 5 }],
      dependencies: [dependencyKey("postgres", "db:5432")],
    });

    const reserve = prearm.reserveFor("GET", "/cart", 1_200);
    if (!reserve) throw new Error("an armed route reports no reserve");
    expect(reserve.armedAt).toBe(1_000);
    expect(reserve.requests).toHaveLength(1);
    const only = reserve.requests[0];
    // The three things that make a row worth keeping. A reserve of requests with no detail is a reserve of
    // nothing, which is exactly what shipped.
    expect(only?.operations).toEqual([{ hash: "abc", startMs: 1, endMs: 5 }]);
    expect(only?.dependencies).toEqual([dependencyKey("postgres", "db:5432")]);
    expect(only?.poolWaitMs).toBe(7);
  });

  it("says there is no reserve for a route nobody armed", () => {
    const prearm = new PrearmRegister();
    prearm.arm("GET /cart", 1_000, 60_000);
    expect(prearm.reserveFor("GET", "/products", 1_200)).toBeNull();
    // And an arm that ran out is not a reserve either.
    expect(prearm.reserveFor("GET", "/cart", 1_000 + 60_001)).toBeNull();
  });

  it("hands a capture what the shared ring had already lost", () => {
    // The case the reserve exists for: an armed route's request survives in the reserve while the global ring
    // is overwritten by everyone else's traffic (ADR 0122).
    const prearm = new PrearmRegister();
    prearm.arm("GET /cart", 1_000, 60_000);
    prearm.observe({
      method: "GET",
      route: "/cart",
      status: 200,
      startedAt: 1_100,
      durationMs: 42,
      operations: [{ hash: "abc", startMs: 1, endMs: 5 }],
      dependencies: [],
    });

    const reserve = prearm.reserveFor("GET", "/cart", 1_200);
    const capture = {
      id: "cap-1",
      startedAt: 1_050,
      endsAt: 2_000,
      footprint: { method: "GET", route: "/cart" },
      reported: false,
    };
    // An empty ring: whatever the reserve does not hold is gone.
    const empty = new FineRegister().snapshot();

    const withReserve = sliceFor(capture, empty, (route) => route, reserve);
    expect(withReserve.requests.map((r) => r.startedAt)).toEqual([1_100]);
    expect(withReserve.requests[0]?.operations).toHaveLength(1);

    // And without it, which is what production did: the capture goes out empty.
    const withoutReserve = sliceFor(capture, empty, (route) => route, null);
    expect(withoutReserve.requests).toHaveLength(0);
  });
});

/**
 * And the half a unit test cannot see: that the **agent** fills the reserve with what it just measured.
 *
 * This is what was broken in production and what nothing caught — the reserve was handed `operations: []` on
 * every request. Driven through the same diagnostics channels a real server publishes on, so what is exercised
 * is the agent's own wiring and not a fixture written to look like it (gh-498).
 */
describe("what the agent puts in the reserve", () => {
  it("is the detail it just measured, not an empty row", async () => {
    const prearm = new PrearmRegister();
    const fine = new FineRegister();
    const agent = new Agent(
      {
        token: "t",
        url: "http://127.0.0.1:1/x",
        environment: "test",
        version: "t1",
        queryText: true,
        minimal: false,
        excludeEndpoints: [],
        excludeDependencies: [],
        inspect: undefined,
        debug: false,
        intervalMs: 60_000,
        // `http` and not an empty set: a request context is only opened when something is going to record
        // into it, and without one there is no detail to put in the reserve. Instrumenting outgoing HTTP
        // subscribes to channels and patches nothing, so it costs this test nothing.
        instrument: new Set(["http"]),
      } as unknown as AgentConfig,
      { fine, prearm, log: { warn: () => {}, debug: () => {} } },
    );
    // Armed before the request, which is the only order in which a reserve can hold anything.
    prearm.arm("GET /cart", Date.now() - 1_000, 60_000);
    agent.start();
    try {
      const request = { method: "GET", url: "/cart" };
      channel("http.server.request.start").publish({ request });
      // Inside the request's own async context, which is where the instrumentation records from.
      recordCall("postgres", "db:5432", 3, false);
      const ctx = currentContext();
      if (!ctx) throw new Error("the agent did not open a request context");
      recordOperationIn(ctx, {
        kind: "query",
        fingerprint: { hash: "b7c1d0f2", text: "SELECT id FROM cart WHERE id = ?" },
        startedAt: 1,
        endedAt: 3,
      });
      channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
    } finally {
      await agent.stop();
    }

    const reserve = prearm.reserveFor("GET", "/cart", Date.now());
    if (!reserve) throw new Error("the route was armed and reports no reserve");
    expect(reserve.requests).toHaveLength(1);
    const only = reserve.requests[0];
    expect(only?.dependencies).toEqual([dependencyKey("postgres", "db:5432")]);
    // The one the shipped version threw away.
    expect(only?.operations.length).toBeGreaterThan(0);
  });
});
