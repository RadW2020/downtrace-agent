import { describe, expect, it } from "vitest";
import { sliceFor } from "../src/captures.ts";
import { dependencyKey } from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";
import { PREARM_MAX_BYTES, PrearmRegister } from "../src/prearm.ts";
import { OTHER_ROUTE } from "../src/routes.ts";

const request = (route: string, startedAt: number, durationMs = 10) => ({
  method: "GET",
  route,
  armRoute: route,
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

  // The reading a capture without a route makes: every route armed right now, with its own window and its
  // own rows (gh-861). An arm that ran out is not armed, and its window ends with it.
  it("reports the reserves of the routes armed right now, and only those", () => {
    const r = new PrearmRegister({ routes: 2, requestsPerRoute: 4 });
    r.arm("GET /cart", 1_000, 60_000);
    r.arm("POST /orders", 2_000, 60_000);
    r.observe(request("/cart", 1_100));

    expect(r.armedReserves(3_000)).toEqual([
      {
        method: "GET",
        route: "/cart",
        armedAt: 1_000,
        requests: [
          {
            method: "GET",
            route: "/cart",
            status: 200,
            startedAt: 1_100,
            durationMs: 10,
            operations: [{ hash: "a", startMs: 1, endMs: 2 }],
            dependencies: [],
            truncated: false,
            detailLost: false,
          },
        ],
      },
      { method: "POST", route: "/orders", armedAt: 2_000, requests: [] },
    ]);
    // The arm of /cart expired, the one of /orders has not: the window of the first is gone, and the second
    // keeps reading.
    expect(r.armedReserves(61_001).map((p) => p.route)).toEqual(["/orders"]);
    expect(r.armedReserves(121_001)).toEqual([]);
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

  // DT-17. The reserve hands a capture the same rows the ring would, and the evidence names the kind of every
  // operation (ADR 0219): a reserve that dropped it would make an armed route's calls read as «did not say».
  it("keeps the kind of each operation it holds", () => {
    const r = new PrearmRegister({ routes: 1, requestsPerRoute: 4 });
    r.arm("GET /cart", 1_000, 60_000);
    r.observe({
      ...request("/cart", 1_100),
      operations: [
        { hash: "q", kind: "query", startMs: 1, endMs: 2 },
        { hash: "c", kind: "call", startMs: 2, endMs: 9 },
        { hash: "r", kind: "command", startMs: 3, endMs: 4 },
        { hash: "e", kind: "error", startMs: 9, endMs: 9 },
        // Written without one, it is read back without one: absent is «did not say», never a guess.
        { hash: "x", startMs: 9, endMs: 9 },
      ],
    });

    const [row] = r.reserveFor("GET", "/cart", 1_200)?.requests ?? [];
    expect(row?.operations.map((o) => [o.hash, o.kind])).toEqual([
      ["q", "query"],
      ["c", "call"],
      ["r", "command"],
      ["e", "error"],
      ["x", undefined],
    ]);
    expect(row?.operations[4]).not.toHaveProperty("kind");
  });

  // ADR 0067: the kind rides in the fingerprint's slot, so a thousand operations more cost what they did.
  it("costs the reserve no column: three numbers per operation, as before", () => {
    const small = new PrearmRegister({ operations: 1_000 });
    const large = new PrearmRegister({ operations: 2_000 });
    expect(large.reservedBytes() - small.reservedBytes()).toBe(1_000 * 3 * Float64Array.BYTES_PER_ELEMENT);
  });

  // Preallocated and bounded by construction, like the other three registers (ADR 0067).
  it("fits its budget with every slot full", () => {
    const r = new PrearmRegister();
    expect(r.bytes()).toBeLessThanOrEqual(PREARM_MAX_BYTES);
    expect(r.bytes()).toBeGreaterThan(0);
  });
});

describe("the label tables of the reserve", () => {
  // gh-805, the younger brother of gh-765. The case of gh-756 — a new name per request — arrives here
  // through the only door the reserve has, an armed route: the interning only ever added, and the memory
  // the agent reported never counted the tables, so neither the budget nor the tripwire could see the
  // growth.

  /** One request of an armed route with a fingerprint and a dependency nobody has seen before. */
  const fresh = (i: number, startedAt: number) => ({
    method: "GET",
    route: "/cart",
    armRoute: "/cart",
    status: 200,
    startedAt,
    durationMs: 10,
    operations: [{ hash: String(i).padStart(16, "0"), startMs: 1, endMs: 2 }],
    dependencies: [dependencyKey("postgres", `db-${i}:5432`)],
  });

  it("counts the names it interns, and stops growing at the cap", () => {
    const r = new PrearmRegister({ routes: 1, requestsPerRoute: 8 });
    r.arm("GET /cart", 1_000, 60_000);
    const empty = r.bytes();
    r.observe(fresh(0, 1_100));
    // A new name costs memory: the tables are part of what the register holds, the way gh-765 made the
    // fine register's tables part of its arithmetic.
    expect(r.bytes()).toBeGreaterThan(empty);
    // Past the cap the traffic costs nothing: a register that still grew here was the bug (invariant 3).
    for (let i = 1; i < 500; i += 1) r.observe(fresh(i, 1_100 + i));
    const at = r.bytes();
    for (let i = 500; i < 1_000; i += 1) r.observe(fresh(i, 1_100 + i));
    expect(r.bytes()).toBe(at);
  });

  it("folds a fingerprint into (other) once the table is full, and says it did", () => {
    const r = new PrearmRegister({ routes: 1, requestsPerRoute: 4, fingerprintLabels: 2 });
    r.arm("GET /cart", 1_000, 60_000);
    r.observe(fresh(0, 1_100));
    r.observe(fresh(1, 1_110));
    r.observe(fresh(2, 1_120)); // the third distinct fingerprint does not fit

    const reserve = r.reserveFor("GET", "/cart", 1_200);
    if (!reserve) throw new Error("an armed route reports no reserve");
    // The row stays true and what is lost is the name, the same fold the fine register makes (COB-01).
    expect(reserve.requests.map((x) => x.operations[0]?.hash)).toEqual([
      "0000000000000000",
      "0000000000000001",
      OTHER_ROUTE,
    ]);
    expect(r.labelsFolded).toBe(1);
  });

  // The row holds four dependency labels, and a capture of a dependency is what reads them (gh-861). A row
  // that touched a fifth cannot be shown not to have used it, so the list that did not fit is marked rather
  // than dropped in silence — the same mark the fine register keeps, and the one the matcher of a capture
  // matches against whatever dependency it is about (invariant 14).
  it("marks a row whose dependency list did not fit, and hands the mark to the capture", () => {
    const r = new PrearmRegister({ routes: 1, requestsPerRoute: 4 });
    r.arm("GET /cart", 1_000, 60_000);
    r.observe({
      method: "GET",
      route: "/cart",
      armRoute: "/cart",
      status: 200,
      startedAt: 1_100,
      durationMs: 10,
      operations: [],
      dependencies: [
        dependencyKey("postgres", "db-0:5432"),
        dependencyKey("redis", "cache-0:6379"),
        dependencyKey("http", "service-0:443"),
        dependencyKey("pgbouncer", "pool-0:6432"),
        dependencyKey("mysql", "db-1:3306"),
      ],
    });

    const rows = r.requestsFor("GET /cart", 1_200);
    expect(rows[0]?.dependencies).toHaveLength(4);
    expect(rows[0]?.dependenciesTruncated).toBe(true);
    // And the shape a capture is assembled from carries the mark, so the slice can count on it.
    const reserve = r.reserveFor("GET", "/cart", 1_200);
    expect(reserve?.requests[0]?.dependenciesTruncated).toBe(true);
    // A row whose list did fit is not marked: the mark is for the gap, and absent means false.
    r.observe({
      method: "GET",
      route: "/cart",
      armRoute: "/cart",
      status: 200,
      startedAt: 1_110,
      durationMs: 10,
      operations: [],
      dependencies: [dependencyKey("postgres", "db-0:5432")],
    });
    expect(r.requestsFor("GET /cart", 1_200)[1]?.dependenciesTruncated).toBeUndefined();
  });

  it("folds a dependency label the same way", () => {
    const r = new PrearmRegister({ routes: 1, requestsPerRoute: 4, dependencyLabels: 2 });
    r.arm("GET /cart", 1_000, 60_000);
    r.observe({
      ...fresh(0, 1_100),
      dependencies: [
        dependencyKey("postgres", "db-0:5432"),
        dependencyKey("redis", "cache-0:6379"),
        dependencyKey("http", "service-0:443"),
      ],
    }); // the third distinct label does not fit

    const reserve = r.reserveFor("GET", "/cart", 1_200);
    if (!reserve) throw new Error("an armed route reports no reserve");
    expect(reserve.requests[0]?.dependencies).toEqual([
      dependencyKey("postgres", "db-0:5432"),
      dependencyKey("redis", "cache-0:6379"),
      OTHER_ROUTE,
    ]);
    expect(r.labelsFolded).toBe(1);
  });

  // What the fold may and may not break. The reserve exists so that a capture of an armed route finds its
  // requests, and a capture of a dependency finds the requests that touched it. A fold costs the name in the
  // row — the row stays true, and the loss is counted — but it must not cost the match: the route a capture
  // is about is the arm's label, which the fold never touches.
  it("still hands a capture of the armed route what it kept, folded or not", () => {
    const r = new PrearmRegister({ routes: 1, requestsPerRoute: 8, fingerprintLabels: 1, dependencyLabels: 1 });
    r.arm("GET /cart", 1_000, 60_000);
    for (let i = 0; i < 6; i += 1) r.observe(fresh(i, 1_100 + i));

    const reserve = r.reserveFor("GET", "/cart", 1_200);
    if (!reserve) throw new Error("an armed route reports no reserve");
    // Every request the route ran while armed is still here, with its timing: what the fold lost is the
    // name inside the row, not the row.
    expect(reserve.requests).toHaveLength(6);
    expect(reserve.requests[0]?.startedAt).toBe(1_100);
    // And the capture of the route reads them: an empty ring and the reserve are all a capture has.
    const capture = {
      id: "cap-1",
      startedAt: 1_050,
      endsAt: 2_000,
      footprint: { method: "GET", route: "/cart" },
      reported: false,
      shedMs: 0,
    };
    const slice = sliceFor(capture, new FineRegister().snapshot(), (route) => route, [reserve]);
    expect(slice.requests.map((x) => x.startedAt)).toEqual([1_100, 1_101, 1_102, 1_103, 1_104, 1_105]);
    // The names are gone to the fold, and the loss is said rather than silent (COB-01): the first request's
    // labels kept their names, and every request after the cap reads the sentinel.
    expect(r.labelsFolded).toBeGreaterThan(0);
    expect(reserve.requests[0]?.dependencies).toEqual([dependencyKey("postgres", "db-0:5432")]);
    expect(reserve.requests[1]?.dependencies).toEqual([OTHER_ROUTE]);
  });

  // The memory half of invariant 3, at the worst case this ticket is about: every route armed, and a
  // fingerprint and a dependency nobody has seen before, on every request, at the longest label each
  // table may hold.
  it("holds its memory budget at the worst case of distinct fingerprints and dependencies", () => {
    const r = new PrearmRegister();
    const routes = ["/cart", "/a", "/b", "/c"];
    for (const route of routes) r.arm(`GET ${route}`, 0, 60_000);
    let i = 0;
    for (const route of routes) {
      for (let n = 0; n < 64; n += 1) {
        r.observe({
          method: "GET",
          route,
          armRoute: route,
          status: 200,
          startedAt: 1_000 + i,
          durationMs: 10,
          operations: Array.from({ length: 16 }, (_, j) => ({
            hash: String(i * 16 + j).padStart(16, "0"),
            startMs: j,
            endMs: j + 1,
          })),
          dependencies: Array.from({ length: 4 }, (_, j) =>
            dependencyKey("postgres", `${"t".repeat(252)}${String(i * 4 + j).padStart(4, "0")}`),
          ),
        });
        i += 1;
      }
    }

    // Every table is at its cap with every label at its longest, so the reserve holds its reserve exactly —
    // a number, not a promise — and the reserve fits the budget the arithmetic is for (ADR 0067).
    expect(r.bytes()).toBe(r.reservedBytes());
    expect(r.bytes()).toBeLessThanOrEqual(PREARM_MAX_BYTES);
  });
});
