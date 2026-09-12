import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { dependencyKey, enterRequest, recordOperationIn } from "../src/context.ts";
import {
  DEFAULT_DEPENDENCIES_PER_REQUEST,
  DEFAULT_OPERATIONS,
  DEFAULT_REQUESTS,
  FINE_MAX_BYTES,
  FineRegister,
} from "../src/fine.ts";

/**
 * The fine half of the black box. What these tests protect is the one thing that makes it worth its cost: the
 * **order and the overlap** of a request's operations, and the honesty of the register when it cannot give them.
 */

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** One request with its operations, written straight into the register. */
function requestWith(r: FineRegister, ops: [hash: string, start: number, end: number][], route = "/orders") {
  const from = r.openRequest();
  for (const [hash, start, end] of ops) r.operation(hash, start, end);
  r.request("GET", route, 200, 0, 100, from, ops.length);
}

describe("the fine register", () => {
  // The sentence the aggregates cannot say: these three ran one after another, and those two overlapped.
  it("keeps the order and the overlap of a request's operations", () => {
    const r = new FineRegister();
    requestWith(r, [
      ["aaa", 1, 5],
      ["bbb", 5, 9],
      ["ccc", 6, 12],
    ]);

    const [request] = r.snapshot().requests;
    expect(request?.operations.map((o) => o.hash)).toEqual(["aaa", "bbb", "ccc"]);
    // Sequential: the second starts where the first ended.
    expect(request?.operations[1]?.startMs).toBe(request?.operations[0]?.endMs);
    // Overlapping: the third started before the second finished, which is what makes it not additive time.
    const [, second, third] = request?.operations ?? [];
    expect(third && second && third.startMs < second.endMs).toBe(true);
  });

  it("records nothing for a request that ran nothing, and says so with an empty list", () => {
    const r = new FineRegister();
    requestWith(r, []);
    const [request] = r.snapshot().requests;
    expect(request?.operations).toEqual([]);
    expect(request?.truncated).toBe(false);
    expect(request?.detailLost).toBe(false);
  });

  // A request that ran a hundred thousand queries must not pass for a small one.
  it("truncates a request past the cap and says it did", () => {
    const r = new FineRegister({ operationsPerRequest: 3 });
    const from = r.openRequest();
    // The caller stops writing at the cap; the count keeps going, which is what makes the difference visible.
    for (let i = 0; i < 3; i += 1) r.operation(`op-${i}`, i, i + 1);
    r.request("GET", "/orders", 200, 0, 100, from, 40);

    const [request] = r.snapshot().requests;
    expect(request?.operations).toHaveLength(3);
    expect(request?.truncated).toBe(true);
  });

  // Invariant 14 in the register: an empty list would read as "it ran nothing", which is not what happened.
  it("says the detail is lost rather than returning somebody else's operations", () => {
    const r = new FineRegister({ requests: 8, operations: 6 });
    requestWith(r, [
      ["old-1", 0, 1],
      ["old-2", 1, 2],
    ]);
    // Enough operations after it to lap the ring.
    requestWith(r, [
      ["new-1", 0, 1],
      ["new-2", 1, 2],
      ["new-3", 2, 3],
      ["new-4", 3, 4],
      ["new-5", 4, 5],
    ]);

    const snapshot = r.snapshot();
    const [older, newer] = snapshot.requests;
    expect(older?.detailLost).toBe(true);
    expect(older?.operations).toEqual([]);
    // And its timing is still true: what is gone is the detail, not the request.
    expect(older?.durationMs).toBe(100);
    // The newer one keeps everything, and none of the old hashes leaked into it.
    expect(newer?.detailLost).toBe(false);
    expect(newer?.operations.map((o) => o.hash)).toEqual(["new-1", "new-2", "new-3", "new-4", "new-5"]);
    expect(snapshot.coverage.detailLost).toBe(1);
  });

  it("overwrites the oldest request, not the newest", () => {
    const r = new FineRegister({ requests: 3, operations: 64 });
    for (let i = 0; i < 5; i += 1) requestWith(r, [], `/route-${i}`);

    const routes = r.snapshot().requests.map((x) => x.route);
    expect(routes).toEqual(["/route-2", "/route-3", "/route-4"]);
  });

  it("does not grow with traffic", () => {
    const r = new FineRegister({ requests: 4, operations: 16 });
    const before = r.bytes();
    for (let i = 0; i < 1000; i += 1) {
      requestWith(r, [
        ["aaa", 0, 1],
        ["bbb", 1, 2],
      ]);
    }
    expect(r.bytes()).toBe(before);
    expect(r.snapshot().requests).toHaveLength(4);
  });

  // The memory half of invariant 3, asserted rather than promised. Since ADR 0032 the other half is manual.
  it("stays inside its memory budget", () => {
    const r = new FineRegister();
    for (let i = 0; i < 100; i += 1) requestWith(r, [["aaa", 0, 1]], `/route-${i}`);

    expect(r.bytes()).toBeLessThanOrEqual(FINE_MAX_BYTES);
    // And it is not passing because the rings are tiny.
    expect(DEFAULT_REQUESTS).toBeGreaterThanOrEqual(1024);
    expect(DEFAULT_OPERATIONS).toBeGreaterThanOrEqual(8192);
    expect(r.bytes()).toBeGreaterThan(512 * 1024);
  });

  // gh-397. A capture of a dependency has to know which requests touched it, and a fingerprint does not
  // say: a Redis call or an outgoing HTTP call produces no operation here at all.
  it("keeps which dependencies each request touched", () => {
    const r = new FineRegister();
    const from = r.openRequest();
    r.request("GET", "/orders", 200, 0, 10, from, 0, [
      dependencyKey("postgres", "db:5432"),
      dependencyKey("redis", "cache:6379"),
    ]);
    r.request("GET", "/health", 200, 0, 1, r.openRequest(), 0, []);

    const [orders, health] = r.snapshot().requests;
    expect(orders?.dependencies).toEqual([dependencyKey("postgres", "db:5432"), dependencyKey("redis", "cache:6379")]);
    expect(orders?.dependenciesTruncated).toBeUndefined();
    expect(health?.dependencies).toEqual([]);
  });

  it("says so when a request touched more dependencies than it keeps", () => {
    // Because the alternative is a request that looks like it never used the ninth one, and a gap read as
    // a fact is what invariant 14 is about.
    const r = new FineRegister();
    const many = Array.from({ length: DEFAULT_DEPENDENCIES_PER_REQUEST + 1 }, (_, i) =>
      dependencyKey("http", `service-${i}:443`),
    );
    r.request("GET", "/orders", 200, 0, 10, r.openRequest(), 0, many);

    const kept = r.snapshot().requests[0];
    expect(kept?.dependencies).toHaveLength(DEFAULT_DEPENDENCIES_PER_REQUEST);
    expect(kept?.dependenciesTruncated).toBe(true);
  });

  it("does not let a lapped dependency ring make a live request look like it touched nothing", () => {
    // The ring is as big as the requests it serves times what one may keep, so a request that is still
    // readable always has its labels. Without that, the filter of a dependency capture would silently
    // drop the oldest requests it should have kept.
    const r = new FineRegister({ requests: 4, operations: 8 });
    for (let i = 0; i < 50; i += 1) {
      r.request("GET", `/r-${i}`, 200, 0, 1, r.openRequest(), 0, [dependencyKey("postgres", `db-${i}:5432`)]);
    }
    for (const request of r.snapshot().requests) {
      expect(request.dependencies).toEqual([dependencyKey("postgres", `db-${request.route.slice(3)}:5432`)]);
    }
  });

  // Invariant 5: what a query was **about** never reaches here. Only what it **is**.
  it("holds hashes and never the text of a query", () => {
    const r = new FineRegister();
    const ctx = enterRequest(r, 0);
    recordOperationIn(ctx, {
      kind: "query",
      fingerprint: { hash: "b7c1d0f2", text: "SELECT id FROM products WHERE id = ?" },
      startedAt: 2,
      endedAt: 7,
    });
    r.request("GET", "/products/:id", 200, 0, 10, ctx.fineFrom, ctx.fineOps);

    const dumped = JSON.stringify(r.snapshot());
    expect(dumped).toContain("b7c1d0f2");
    expect(dumped).not.toContain("SELECT");
    expect(dumped).not.toContain("products WHERE");
  });

  it("makes an operation's times relative to its own request", () => {
    const r = new FineRegister();
    // A request that started late in the process's life: the offsets must still be small.
    const ctx = enterRequest(r, 1_000_000);
    recordOperationIn(ctx, {
      kind: "query",
      fingerprint: { hash: "aaa", text: "" },
      startedAt: 1_000_003,
      endedAt: 1_000_009,
    });
    r.request("GET", "/orders", 200, 1_000_000, 10, ctx.fineFrom, ctx.fineOps);

    const [op] = r.snapshot().requests[0]?.operations ?? [];
    expect(op?.startMs).toBe(3);
    expect(op?.endMs).toBe(9);
  });

  it("stops writing past the cap but keeps counting", () => {
    const r = new FineRegister({ operationsPerRequest: 2 });
    const ctx = enterRequest(r, 0);
    for (let i = 0; i < 5; i += 1) {
      recordOperationIn(ctx, {
        kind: "query",
        fingerprint: { hash: `op-${i}`, text: "" },
        startedAt: i,
        endedAt: i + 1,
      });
    }
    r.request("GET", "/orders", 200, 0, 10, ctx.fineFrom, ctx.fineOps);

    expect(ctx.fineOps).toBe(5);
    const [request] = r.snapshot().requests;
    expect(request?.operations).toHaveLength(2);
    expect(request?.truncated).toBe(true);
  });

  // The reason the cap limits **writes** and not only reads: one runaway request must not cost everybody else
  // their detail. Without it, a request that runs twenty queries laps a small ring and takes the neighbours
  // with it.
  it("does not let one runaway request empty the ring for the others", () => {
    const r = new FineRegister({ requests: 8, operations: 8, operationsPerRequest: 2 });

    const quiet = enterRequest(r, 0);
    for (let i = 0; i < 2; i += 1) {
      recordOperationIn(quiet, {
        kind: "query",
        fingerprint: { hash: `quiet-${i}`, text: "" },
        startedAt: i,
        endedAt: i + 1,
      });
    }
    r.request("GET", "/quiet", 200, 0, 10, quiet.fineFrom, quiet.fineOps);

    const runaway = enterRequest(r, 0);
    for (let i = 0; i < 20; i += 1) {
      recordOperationIn(runaway, {
        kind: "query",
        fingerprint: { hash: `loop-${i}`, text: "" },
        startedAt: i,
        endedAt: i + 1,
      });
    }
    r.request("GET", "/n-plus-one", 200, 0, 10, runaway.fineFrom, runaway.fineOps);

    const [first, second] = r.snapshot().requests;
    expect(first?.route).toBe("/quiet");
    expect(first?.detailLost).toBe(false);
    expect(first?.operations.map((o) => o.hash)).toEqual(["quiet-0", "quiet-1"]);
    // And the runaway is still reported as what it was: truncated, not small.
    expect(second?.truncated).toBe(true);
  });

  // A caller that reports more operations than it wrote must not make the snapshot read the next request's rows.
  it("never reads past what was actually written", () => {
    const r = new FineRegister({ requests: 8, operations: 16, operationsPerRequest: 10 });
    const from = r.openRequest();
    r.operation("mine-1", 0, 1);
    r.operation("mine-2", 1, 2);
    // Reports five, wrote two.
    r.request("GET", "/orders", 200, 0, 10, from, 5);
    requestWith(r, [["theirs", 0, 1]], "/other");

    const [first] = r.snapshot().requests;
    expect(first?.operations.map((o) => o.hash)).toEqual(["mine-1", "mine-2"]);
  });

  it("records nothing outside a request", () => {
    const r = new FineRegister();
    // No context: `recordOperationIn` is never reached, and the register stays empty.
    expect(r.snapshot().requests).toHaveLength(0);
  });
});

describe("the agent's fine register", () => {
  it("records a finished request into it, with or without instrumentation", async () => {
    const fine = new FineRegister({ requests: 8, operations: 16 });
    const agent = createAgent(
      {
        token: "test-token",
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
        instrument: new Set(),
      },
      { fine, log: silent },
    );
    agent.start();
    try {
      const request = { method: "GET", url: "/orders" };
      channel("http.server.request.start").publish({ request });
      channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
    } finally {
      await agent.stop();
    }

    const [recorded] = fine.snapshot().requests;
    expect(recorded?.method).toBe("GET");
    expect(recorded?.status).toBe(200);
    expect(recorded?.operations).toEqual([]);
  });
});

describe("pool wait", () => {
  // The wait for a connection is measured per request already —`pg.ts` records it into the request's own
  // context— and until gh-471 it died with the request. The pool-saturation trigger compares wait per request
  // against the reference's, so counting how many waited more needs the number per request (gh-471).
  it("keeps the wait a request spent waiting for a connection", () => {
    const r = new FineRegister();
    r.request("GET", "/cart", 200, 1_000, 40, r.openRequest(), 0, undefined, 12.5);
    r.request("GET", "/cart", 200, 1_100, 40, r.openRequest(), 0, undefined, 0);

    const [waited, instant] = r.snapshot().requests;
    expect(waited?.poolWaitMs).toBe(12.5);
    // Zero is a measurement: this one asked the pool and got a connection at once.
    expect(instant?.poolWaitMs).toBe(0);
  });

  // A request that never asked a pool for anything has no wait to report, and that is not a wait of zero.
  // Absent and zero are different answers and the contract reads them differently (invariant 14).
  it("says nothing when the request touched no pool", () => {
    const r = new FineRegister();
    r.request("GET", "/static", 200, 1_000, 3, r.openRequest(), 0);

    expect(r.snapshot().requests[0]?.poolWaitMs).toBeUndefined();
  });

  // The row grew by one number, so the arithmetic of the memory budget has to still hold: the register is
  // bounded by construction and that is the half of invariant 3 that checks itself (ADR 0067).
  it("still fits the memory budget with the wait in every row", () => {
    const r = new FineRegister();
    expect(r.bytes()).toBeLessThanOrEqual(FINE_MAX_BYTES);
  });
});
