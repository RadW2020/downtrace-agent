import { describe, expect, it } from "vitest";
import { REGRESSIONS, Regressions } from "../src/index.ts";

describe("reference app", () => {
  it("declares five distinct regressions", () => {
    expect(REGRESSIONS).toHaveLength(5);
    expect(new Set(REGRESSIONS).size).toBe(REGRESSIONS.length);
  });

  it("parses REGRESSIONS from the environment", () => {
    const r = Regressions.fromEnv(" n_plus_one, slow_dependency ,");
    expect(r.enabled()).toEqual(["n_plus_one", "slow_dependency"]);
    expect(() => Regressions.fromEnv("nope")).toThrow(/unknown regression/);
  });

  it("validates admin patches", () => {
    const r = new Regressions();
    r.update({ slow_dependency: { enabled: true, params: { delayMs: 300 } } });
    expect(r.isEnabled("slow_dependency")).toBe(true);
    expect(r.params("slow_dependency").delayMs).toBe(300);
    expect(() => r.update({ pool_leak: { params: { rate: 2 } } })).toThrow(/within \[0, 1\]/);
    expect(() => r.update({ n_plus_one: { params: { delayMs: 1 } } })).toThrow(/not a parameter/);
    expect(() => r.update({ bogus: { enabled: true } })).toThrow(/unknown regression/);
  });
});
