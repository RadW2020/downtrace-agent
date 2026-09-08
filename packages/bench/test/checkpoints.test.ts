import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type CheckpointWork, checkpointsSince } from "../src/process-sampler.ts";
import { applyCheckpointStorms } from "../src/verdict.ts";

/**
 * Postgres decides on its own when to write dirty pages, and in a real run it did so for twenty-six seconds
 * straight inside a benchmark that measures in windows of sixty. The benchmark does not own that database — it
 * measures against whatever `DATABASE_URL` points at — so it reads the counters and says what it measured
 * against, the way it already does with the neighbouring CPU (gh-194, ADR 0031).
 */

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function app(body: unknown, status = 200) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("reading what the database did", () => {
  it("reports the difference between two readings, not the running total", async () => {
    const url = await app({ available: true, timed: 714, requested: 1525, writeMs: 1_663_447, syncMs: 5402 });
    const before = await checkpointsSince(url);
    const after = await checkpointsSince(url);
    expect(before).toBeDefined();
    expect(subtract(before, after)).toEqual({ count: 0, writeMs: 0 });
  });

  it("says it does not know rather than saying zero", async () => {
    // Another engine, or no permission on the view. Not knowing is not a quiet database.
    const url = await app({ available: false });
    expect(await checkpointsSince(url)).toBeUndefined();
  });

  it("does not take the round down when the app will not answer", async () => {
    const url = await app({}, 500);
    expect(await checkpointsSince(url)).toBeUndefined();
  });
});

function subtract(a: CheckpointWork | undefined, b: CheckpointWork | undefined) {
  if (!a || !b) return undefined;
  return { count: b.timed + b.requested - (a.timed + a.requested), writeMs: b.writeMs - a.writeMs };
}

describe("a pair where the database wrote in only one half", () => {
  const half = (round: number, variant: "baseline" | "agent", writeMs: number | undefined) => ({
    round,
    variant,
    checkpointWriteMs: writeMs,
  });

  // The round that motivated this: 26 s of checkpoint writing inside one sixty-second window.
  it("cannot conclude when a storm landed on the agent's half", () => {
    const out = applyCheckpointStorms("pass", undefined, [half(3, "baseline", 12), half(3, "agent", 26_459)]);
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toContain("3");
  });

  it("cannot conclude when it landed on the baseline's half either", () => {
    // Contaminating the baseline flatters the agent, so this direction matters more, not less.
    const out = applyCheckpointStorms("pass", undefined, [half(7, "baseline", 24_359), half(7, "agent", 30)]);
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toContain("7");
  });

  it("leaves an even trickle alone", () => {
    const out = applyCheckpointStorms("pass", undefined, [half(1, "baseline", 120), half(1, "agent", 300)]);
    expect(out.verdict).toBe("pass");
    expect(out.reason).toBeUndefined();
  });

  it("does not turn a failure into an inconclusive", () => {
    const out = applyCheckpointStorms("fail", "over budget", [half(1, "baseline", 0), half(1, "agent", 26_000)]);
    expect(out.verdict).toBe("fail");
    expect(out.reason).toContain("over budget");
  });

  it("says nothing when the counters could not be read", () => {
    const out = applyCheckpointStorms("pass", undefined, [half(1, "baseline", undefined), half(1, "agent", undefined)]);
    expect(out.verdict).toBe("pass");
  });
});
