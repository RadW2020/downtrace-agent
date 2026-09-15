import { AGGREGATES_PATH } from "@downtrace/protocol";
import { describe, expect, it } from "vitest";
import { Sink } from "../src/sink.ts";

/**
 * The sink stands in for the cloud and counts what the agent shipped. Since gh-570 it also reads what the agent
 * says about itself: the estimate of its own hooks per request that every batch carries (ADR 0080), so the report
 * can say how much of the measured CPU is inside the hooks and how much runs outside them.
 */
async function post(url: string, body: unknown, token = "Bearer bench"): Promise<number> {
  const res = await fetch(url + AGGREGATES_PATH, {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
}
const batch = (hookMsPerRequest?: number) => ({
  intervals: [{ endpoints: [{ count: 10 }, { count: 5 }] }],
  agent: hookMsPerRequest === undefined ? {} : { resources: { hookMsPerRequest } },
});

describe("the sink", () => {
  it("counts batches, intervals, endpoints and requests", async () => {
    const sink = new Sink();
    const url = await sink.listen();
    try {
      expect(await post(url, batch())).toBe(202);
      expect(sink.stats).toMatchObject({ batches: 1, intervals: 1, endpoints: 2, requests: 15, rejected: 0 });
      expect(sink.stats.hookMsPerRequest).toBeUndefined();
    } finally {
      await sink.close();
    }
  });

  it("keeps the mean of the agent's own hook estimate over the batches that carried one", async () => {
    const sink = new Sink();
    const url = await sink.listen();
    try {
      await post(url, batch(0.04));
      await post(url, batch()); // a batch without the estimate does not count as zero
      await post(url, batch(0.06));
      expect(sink.stats.batches).toBe(3);
      expect(sink.stats.hookMsPerRequest).toBeCloseTo(0.05, 9);
    } finally {
      await sink.close();
    }
  });

  it("ignores an estimate that is not a finite number", async () => {
    const sink = new Sink();
    const url = await sink.listen();
    try {
      await post(url, { ...batch(), agent: { resources: { hookMsPerRequest: "fast" } } });
      expect(sink.stats.hookMsPerRequest).toBeUndefined();
    } finally {
      await sink.close();
    }
  });

  it("rejects a batch without a bearer token, and counts it", async () => {
    const sink = new Sink();
    const url = await sink.listen();
    try {
      expect(await post(url, batch(), "")).toBe(401);
      expect(sink.stats.rejected).toBe(1);
    } finally {
      await sink.close();
    }
  });
});
