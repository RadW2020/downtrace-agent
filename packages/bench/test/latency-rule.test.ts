import { describe, expect, it } from "vitest";
import { latencyStatus } from "../src/latency-rule.ts";

const rule = (over: Partial<Parameters<typeof latencyStatus>[0]> = {}) =>
  latencyStatus({
    pooledBaseline: 20,
    pooledAgent: 20,
    splitHalfNoise: 0.5,
    baselineRounds: [20, 20, 20],
    agentRounds: [20, 20, 20],
    budget: 1,
    ...over,
  });

describe("latencyStatus", () => {
  it("is ok while the difference stays inside the budget", () => {
    const r = rule({ pooledAgent: 20.6, agentRounds: [20.6, 20.6, 20.6] });
    expect(r.status).toBe("ok");
    expect(r.delta).toBeCloseTo(0.6);
  });

  it("takes the noise from the spread between rounds when that is larger than the sampling noise", () => {
    const r = rule({ baselineRounds: [20, 22.1, 20] });
    expect(r.noise).toBeCloseTo(2.1);
    expect(r.noiseSource).toBe("round-spread");
  });

  it("keeps the split-half estimate when the rounds are steady", () => {
    const r = rule({ splitHalfNoise: 1.4, baselineRounds: [20, 20.2, 20.1] });
    expect(r.noise).toBeCloseTo(1.4);
    expect(r.noiseSource).toBe("split-half");
  });

  it("fails when the difference beats budget and noise in most rounds", () => {
    const r = rule({ pooledAgent: 25, agentRounds: [25, 25.2, 24.8] });
    expect(r.status).toBe("fail");
    expect(r.corroborating).toBe(3);
  });

  it("withholds the fail when a single round carries the whole difference", () => {
    const r = rule({ pooledAgent: 60, agentRounds: [20.4, 191, 20.1] });
    expect(r.status).toBe("inconclusive");
    expect(r.reason).toBe("one round dominates the tail (1/3 rounds corroborate)");
  });

  it("a strict majority is needed, so one of two rounds is not enough", () => {
    const r = rule({ pooledAgent: 30, agentRounds: [40, 20], baselineRounds: [20, 20] });
    expect(r.corroborating).toBe(1);
    expect(r.status).toBe("inconclusive");
  });
});

/** The two CI runs that motivated the rule, replayed from the figures in their own reports. */
describe("the runs that motivated the rule", () => {
  it("gate run 33967738239: inconclusive on the round spread, not fail", () => {
    const r = latencyStatus({
      pooledBaseline: 19.162,
      pooledAgent: 20.44,
      splitHalfNoise: 1.181,
      baselineRounds: [18.52, 19.61, 20.17, 19.65, 18.31],
      agentRounds: [21.86, 21.11, 19.61, 22.37, 18.43],
      budget: 1,
    });
    expect(r.delta).toBeCloseTo(1.278, 2);
    expect(r.noise).toBeCloseTo(1.86, 1); // the baseline rounds spread further than the sampling noise
    expect(r.noiseSource).toBe("round-spread");
    expect(r.status).toBe("inconclusive");
  });

  it("integration run 33967120965: one stalled round no longer fails the test", () => {
    const r = latencyStatus({
      pooledBaseline: 16.2,
      pooledAgent: 167.05,
      splitHalfNoise: 1.5,
      baselineRounds: [15.61, 14.76, 16.37],
      agentRounds: [17.47, 191.01, 15.98],
      budget: 1,
    });
    expect(r.status).toBe("inconclusive");
    expect(r.corroborating).toBe(1);
    expect(r.reason).toMatch(/one round dominates the tail \(1\/3/);
  });

  it("a tail regression in every round is still a fail", () => {
    const r = latencyStatus({
      pooledBaseline: 20,
      pooledAgent: 200,
      splitHalfNoise: 1.8,
      baselineRounds: [19.5, 20.2, 20.1, 19.9, 20.3],
      agentRounds: [198, 201, 205, 199, 202],
      budget: 1,
    });
    expect(r.status).toBe("fail");
    expect(r.corroborating).toBe(5);
  });
});
