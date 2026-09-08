import { AGGREGATES_SCHEMA_V0, type Interval, PROTOCOL_VERSION, type Profile } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { Logger } from "../src/log.ts";
import { DEFAULT_MAX_QUEUED, Sender } from "../src/transport.ts";

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
    expect(calls[0]?.body).toMatchObject({ protocol: PROTOCOL_VERSION, intervals: [{ start: 1 }, { start: 2 }] });
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

describe("Sender, carrying the profile", () => {
  const profile = (start: number): Profile => ({
    start,
    durationMs: 60_000,
    endpoints: [
      {
        method: "GET",
        route: "/products/:id",
        operations: [
          { kind: "query", hash: "abc123", text: "SELECT id FROM products WHERE id = ?", count: 3, totalMs: 4.5 },
        ],
      },
    ],
  });

  /** The batch as the cloud would receive it, without casting through an optional chain. */
  const bodyOf = (call: { body: unknown } | undefined): { profile?: Profile } =>
    (call?.body ?? {}) as { profile?: Profile };

  it("puts the profile on the batch", async () => {
    const { s, calls } = sender([202]);
    s.enqueue(interval(1));
    s.enqueueProfile(profile(1));
    await s.flush();
    expect(bodyOf(calls[0]).profile).toEqual(profile(1));
  });

  it("does not put a profile field on a batch that has none", async () => {
    const { s, calls } = sender([202]);
    s.enqueue(interval(1));
    await s.flush();
    expect(calls[0]?.body).not.toHaveProperty("profile");
  });

  it("keeps a profile whose batch never arrived, and sends it with the next one", async () => {
    const { s, calls } = sender([500, 202]);
    s.enqueue(interval(1));
    s.enqueueProfile(profile(1));
    expect(await s.flush()).toBe(false);
    expect(await s.flush()).toBe(true);
    expect(bodyOf(calls[1]).profile?.start).toBe(1);
  });

  it("sends one profile per batch, oldest first", async () => {
    const { s, calls } = sender([202, 202]);
    s.enqueue(interval(1));
    s.enqueueProfile(profile(1));
    s.enqueueProfile(profile(2));
    await s.flush();
    s.enqueue(interval(2));
    await s.flush();
    expect(bodyOf(calls[0]).profile?.start).toBe(1);
    expect(bodyOf(calls[1]).profile?.start).toBe(2);
  });

  it("drops the oldest profile rather than growing while the cloud is unreachable", () => {
    const { s } = sender([]);
    for (let i = 0; i < DEFAULT_MAX_QUEUED + 3; i++) s.enqueueProfile(profile(i));
    expect(s.dropped).toBe(3);
  });

  it("sends a batch the protocol schema accepts", async () => {
    const { s, calls } = sender([202]);
    s.enqueue(interval(1));
    s.enqueueProfile(profile(1));
    await s.flush();
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addKeyword("x-latency-boundaries-ms");
    ajv.addKeyword("x-calls-per-request-boundaries");
    ajv.addKeyword("x-ingest-path");
    const validate = ajv.compile(AGGREGATES_SCHEMA_V0);
    expect(validate(calls[0]?.body), JSON.stringify(validate.errors)).toBe(true);
  });
});

/**
 * A batch the cloud rejects as invalid will be rejected the same way tomorrow. Retrying it wasted a queue slot —
 * displacing batches that were fine — and `failed` could not tell "the cloud is down" from "I am producing
 * something it does not accept", which are two problems with opposite fixes (gh-205).
 */
describe("Sender, when the batch itself is the problem", () => {
  const rejecting = (status: number) => sender([status, 202]);

  for (const status of [400, 413, 422]) {
    it(`drops the batch on ${status} instead of retrying it forever`, async () => {
      const { s, calls } = rejecting(status);
      s.enqueue(interval(1));
      expect(await s.flush()).toBe(false);
      expect(s.pending).toBe(0);
      expect(s.rejected).toBe(1);
      // Nothing left to send: a second flush must not put it back on the wire.
      expect(await s.flush()).toBe(false);
      expect(calls).toHaveLength(1);
    });
  }

  // The reason the ticket exists: an invalid batch must not displace the good ones.
  it("does not let a rejected batch keep a slot from a valid one", async () => {
    const { s, calls } = sender([400, 202]);
    s.enqueue(interval(1));
    await s.flush();
    s.enqueue(interval(2));
    expect(await s.flush()).toBe(true);
    const sent = calls[1]?.body as { intervals: { start: number }[] };
    expect(sent.intervals.map((iv) => iv.start)).toEqual([2]);
  });

  it("says it once, not on every interval", async () => {
    const said: string[] = [];
    const { s } = sender([400, 400], { warn: (m) => said.push(m), debug: () => {} });
    s.enqueue(interval(1));
    await s.flush();
    s.enqueue(interval(2));
    await s.flush();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("400");
  });

  // Credentials are the opposite case: wrong today, right once the operator fixes them, and then those six
  // intervals are worth having.
  it("keeps the batch on 401, because a fixed token makes it valuable again", async () => {
    const { s } = sender([401]);
    s.enqueue(interval(1));
    await s.flush();
    expect(s.pending).toBe(1);
    expect(s.rejected).toBe(0);
  });

  it("keeps the batch on 500, as before", async () => {
    const { s } = sender([500]);
    s.enqueue(interval(1));
    await s.flush();
    expect(s.pending).toBe(1);
    expect(s.rejected).toBe(0);
  });
});

describe("Sender, when the cloud asks for time", () => {
  const limited = (retryAfter: string | undefined, then: number[] = [202]) => {
    const responses: Array<number | Error> = [429, ...then];
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const next = responses.shift() ?? 202;
      if (next instanceof Error) throw next;
      const headers = retryAfter !== undefined && next === 429 ? { "retry-after": retryAfter } : undefined;
      return new Response(null, { status: next, ...(headers ? { headers } : {}) });
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const s = new Sender({
      url: "http://cloud.test",
      token: "tok",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl,
      now: () => now,
    });
    return { s, calls, advance: (ms: number) => (now += ms) };
  };

  it("waits the seconds it was asked for, and not less", async () => {
    const { s, calls, advance } = limited("30");
    s.enqueue(interval(1));
    await s.flush();
    expect(calls).toHaveLength(1);

    advance(29_000);
    expect(await s.flush()).toBe(false);
    expect(calls, "asked again before the time was up").toHaveLength(1);

    advance(2_000);
    expect(await s.flush()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  // The cloud's largest legitimate value is the seconds until the next UTC day, when the daily budget is spent.
  // The cap is there so a nonsense value cannot silence the instrumentation for ever, not to disobey the cloud.
  it("obeys a whole day, and caps anything beyond it", async () => {
    const { s, calls, advance } = limited("1000000");
    s.enqueue(interval(1));
    await s.flush();

    advance(24 * 60 * 60 * 1000 - 1000);
    expect(await s.flush()).toBe(false);
    expect(calls).toHaveLength(1);

    advance(2000);
    await s.flush();
    expect(calls).toHaveLength(2);
  });

  it("takes an HTTP date, which the standard allows", async () => {
    const { s, calls, advance } = limited(new Date(1_000_000 + 45_000).toUTCString());
    s.enqueue(interval(1));
    await s.flush();
    advance(44_000);
    await s.flush();
    expect(calls).toHaveLength(1);
    advance(2_000);
    await s.flush();
    expect(calls).toHaveLength(2);
  });

  for (const bad of [undefined, "", "soon", "-5"]) {
    it(`ignores an unusable Retry-After (${JSON.stringify(bad)}) and behaves like any 429`, async () => {
      const { s, calls } = limited(bad);
      s.enqueue(interval(1));
      await s.flush();
      // No wait to respect: the next flush goes out, and the batch was kept because 429 is not the batch's fault.
      expect(await s.flush()).toBe(true);
      expect(calls).toHaveLength(2);
    });
  }

  it("keeps aggregating while it waits: not being able to send is no reason to stop measuring", async () => {
    const { s, advance } = limited("60");
    s.enqueue(interval(1));
    await s.flush();
    for (let i = 2; i <= 4; i++) s.enqueue(interval(i));
    expect(s.pending).toBe(4);
    advance(61_000);
    expect(await s.flush()).toBe(true);
  });
});
