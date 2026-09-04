import type { Interval } from "@downtrace/protocol";
import { describe, expect, it } from "vitest";
import type { Logger } from "../src/log.ts";
import { Sender } from "../src/transport.ts";

const interval = (start: number): Interval => ({ start, durationMs: 10_000, endpoints: [] });
const quiet: Logger = { warn: () => {}, debug: () => {} };

function sender(responses: Array<number | Error>, log: Logger = quiet) {
  const calls: { url: string; auth: string | undefined; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), auth: headers.authorization, body: JSON.parse(String(init?.body)) });
    const next = responses.shift() ?? 202;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
  const s = new Sender({
    url: "http://cloud.test",
    token: "tok",
    agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
    instance: { id: "i", hostname: "h", pid: 1 },
    deploy: { version: "v", environment: "test" },
    log,
    fetchImpl,
  });
  return { s, calls };
}

describe("Sender", () => {
  it("posts a protocol batch with the bearer token and clears the queue on success", async () => {
    const { s, calls } = sender([202]);
    s.enqueue(interval(1));
    s.enqueue(interval(2));
    expect(await s.flush()).toBe(true);
    expect(calls[0]?.url).toBe("http://cloud.test/v0/aggregates");
    expect(calls[0]?.auth).toBe("Bearer tok");
    expect(calls[0]?.body).toMatchObject({ protocol: "0.1.0", intervals: [{ start: 1 }, { start: 2 }] });
    expect(s.pending).toBe(0);
    expect(s.sent).toBe(1);
  });

  it("keeps intervals queued when the cloud fails or is unreachable, bounded to 6", async () => {
    const { s } = sender([500, new Error("ECONNREFUSED"), 503, 502, 500, 500, 500, 500, 500, 500]);
    for (let i = 1; i <= 10; i++) {
      s.enqueue(interval(i));
      expect(await s.flush()).toBe(false);
    }
    expect(s.pending).toBe(6);
    expect(s.dropped).toBe(4);
    expect(s.failed).toBe(10);
  });

  it("warns once on 401 and keeps going", async () => {
    const warnings: string[] = [];
    const { s } = sender([401, 401], { warn: (m) => warnings.push(m), debug: () => {} });
    s.enqueue(interval(1));
    await s.flush();
    await s.flush();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/401/);
  });

  it("does nothing with an empty queue and never overlaps flushes", async () => {
    const { s, calls } = sender([202]);
    expect(await s.flush()).toBe(false);
    s.enqueue(interval(1));
    const [a, b] = await Promise.all([s.flush(), s.flush()]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(calls).toHaveLength(1);
  });
});
