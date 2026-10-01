import { REGRESSIONS } from "@downtrace/reference-app";
import { describe, expect, it } from "vitest";
import { EXPECTATIONS, type FindingSummary, matches, regressionFor } from "../src/canary-expectations.ts";

const checkoutFinding: FindingSummary = {
  id: 7,
  state: "open",
  trigger: "composition_shift",
  scope: "route",
  endpoint: { method: "POST", route: "/checkout" },
  dependency: { kind: "postgres", target: "postgres:5432" },
  since: "2026-10-02T01:10:00Z",
};

describe("EXPECTATIONS", () => {
  it("names the finding every regression of the reference app should cause, enumerated from its source", () => {
    for (const name of REGRESSIONS) {
      expect(EXPECTATIONS[name], name).toBeDefined();
    }
  });

  it("names no regression the reference app does not have", () => {
    expect(Object.keys(EXPECTATIONS).sort()).toEqual([...REGRESSIONS].sort());
  });

  it("switches every regression on in its own night, and nothing the reference app does not have", () => {
    for (const name of REGRESSIONS) {
      const switched = Object.keys(EXPECTATIONS[name].switches);
      expect(switched, name).toContain(name);
      for (const other of switched) expect(REGRESSIONS, `${name} switches ${other}`).toContain(other);
    }
  });

  it("gives every expectation a trigger, a pattern and a place to look", () => {
    for (const name of REGRESSIONS) {
      const e = EXPECTATIONS[name];
      expect(e.triggers.length, name).toBeGreaterThan(0);
      expect(e.patterns.length, name).toBeGreaterThan(0);
      expect(e.routes.length + e.dependencyKinds.length, name).toBeGreaterThan(0);
    }
  });
});

describe("matches", () => {
  it("takes a finding of an expected trigger on an expected route", () => {
    expect(matches(checkoutFinding, EXPECTATIONS.n_plus_one)).toBe(true);
  });

  it("refuses a trigger the expectation does not name", () => {
    expect(matches({ ...checkoutFinding, trigger: "latency_shift" }, EXPECTATIONS.n_plus_one)).toBe(false);
  });

  it("refuses the right trigger on another route, and the same path under another method", () => {
    expect(
      matches({ ...checkoutFinding, endpoint: { method: "GET", route: "/products" } }, EXPECTATIONS.n_plus_one),
    ).toBe(false);
    expect(
      matches({ ...checkoutFinding, endpoint: { method: "GET", route: "/checkout" } }, EXPECTATIONS.n_plus_one),
    ).toBe(false);
  });

  it("takes a finding about a dependency by its kind, with no route", () => {
    const pool: FindingSummary = {
      ...checkoutFinding,
      trigger: "pool_saturation",
      scope: "dependency",
      endpoint: null,
      dependency: { kind: "postgres", target: "postgres:5432" },
    };
    expect(matches(pool, EXPECTATIONS.pool_leak)).toBe(true);
    expect(matches({ ...pool, dependency: { kind: "redis", target: "redis:6379" } }, EXPECTATIONS.pool_leak)).toBe(
      false,
    );
  });

  it("refuses a closed finding: what the canary waits for is one that is open", () => {
    expect(matches({ ...checkoutFinding, state: "closed" }, EXPECTATIONS.n_plus_one)).toBe(false);
  });
});

describe("regressionFor", () => {
  const day = (iso: string) => new Date(iso);

  it("gives every regression one night in five consecutive nights", () => {
    const nights = ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"].map((d) =>
      regressionFor(day(`${d}T01:00:00Z`)),
    );
    expect([...nights].sort()).toEqual([...REGRESSIONS].sort());
  });

  it("gives the same regression all along one UTC day, so a retried night measures the same thing", () => {
    expect(regressionFor(day("2026-10-02T00:00:00Z"))).toBe(regressionFor(day("2026-10-02T23:59:59Z")));
  });
});
