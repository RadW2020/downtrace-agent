import { describe, expect, it } from "vitest";
import { evaluate, type RoundMetrics } from "../src/verdict.ts";

const r = (p99Ms: number, cpuPct = 10, rssMb = 100): RoundMetrics => ({ p99Ms, cpuPct, rssMb });

describe("evaluate", () => {
  it("passes when every delta is within budget", () => {
    const { metrics, verdict } = evaluate([r(5.0), r(5.2), r(4.9)], [r(5.4), r(5.5), r(5.3)]);
    expect(verdict).toBe("pass");
    expect(metrics.find((m) => m.metric === "p99Ms")).toMatchObject({ delta: 0.4, noise: 0.3, status: "ok" });
  });

  it("fails when a delta exceeds both the budget and the machine noise", () => {
    const { metrics, verdict } = evaluate([r(5.0), r(5.2), r(4.9)], [r(10.0), r(10.4), r(9.8)]);
    expect(verdict).toBe("fail");
    expect(metrics.find((m) => m.metric === "p99Ms")?.status).toBe("fail");
    expect(metrics.find((m) => m.metric === "cpuPct")?.status).toBe("ok");
  });

  it("is inconclusive when the delta exceeds the budget but not the noise", () => {
    const { metrics, verdict } = evaluate([r(3.0), r(9.0), r(5.0)], [r(7.0), r(7.5), r(6.8)]);
    // baseline median 5, agent median 7 → delta 2 > budget 1, but baseline noise is 6
    expect(verdict).toBe("inconclusive");
    expect(metrics.find((m) => m.metric === "p99Ms")?.status).toBe("inconclusive");
  });

  it("fail wins over inconclusive", () => {
    const { verdict } = evaluate([r(3.0, 10), r(9.0, 10), r(5.0, 10)], [r(7.0, 20), r(7.5, 20), r(6.8, 20)]);
    expect(verdict).toBe("fail"); // cpu +10 pp, no noise
  });

  it("rejects empty input", () => {
    expect(() => evaluate([], [r(1)])).toThrow(/at least one round/);
  });
});
