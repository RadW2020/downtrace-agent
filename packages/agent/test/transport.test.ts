import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AGGREGATES_SCHEMA_V0,
  type CaptureProgress,
  type Interval,
  type LocalTrigger,
  PROTOCOL_VERSION,
  type Profile,
} from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { CountedException } from "../src/exceptions.ts";
import type { Logger } from "../src/log.ts";
import { DEFAULT_MAX_QUEUED, type PendingCapture, Sender } from "../src/transport.ts";

const interval = (start: number): Interval => ({ start, durationMs: 10_000, endpoints: [] });
const quiet: Logger = { warn: () => {}, debug: () => {} };

/** The answers the cloud publishes, read from the protocol's own fixtures instead of retyped here. */
const RESPONSES = fileURLToPath(new URL("../../protocol/schema/v0/fixtures/response/valid/", import.meta.url));
const fixture = (name: string): Promise<string> => readFile(RESPONSES + name, "utf8");
async function allFixtures(): Promise<[string, string][]> {
  const names = (await readdir(RESPONSES)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(names.map(async (f) => [f, await fixture(f)] as [string, string]));
}

function sender(responses: Array<number | Error>, log: Logger = quiet, responseBody?: string) {
  const calls: { url: string; auth: string | undefined; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), auth: headers.authorization, body: JSON.parse(String(init?.body)) });
    const next = responses.shift() ?? 202;
    if (next instanceof Error) throw next;
    return new Response(responseBody ?? null, { status: next });
  }) as unknown as typeof fetch;
  const s = new Sender({
    url: "http://cloud.test",
    token: "tok",
    agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
    instance: { id: "i", hostname: "h", pid: 1 },
    deploy: { version: "v", environment: "test" },
    log,
    fetchImpl,
    // A clock that does not move: nothing in these waits on a Retry-After, and the ones that do drive their own.
    now: () => 1_000_000,
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
    ajv.addKeyword("x-since");
    const validate = ajv.compile(AGGREGATES_SCHEMA_V0);
    expect(validate(calls[0]?.body), JSON.stringify(validate.errors)).toBe(true);
  });
});

/**
 * A batch the cloud rejects as invalid will be rejected the same way tomorrow. Retrying it wasted a queue slot —
 * displacing batches that were fine — and `failed` could not tell "the cloud is down" from "I am producing
 * something it does not accept", which are two problems with opposite fixes (gh-205).
 */
/**
 * ADR 0008 in one test. Since protocol 0.8.0 the cloud's answer carries the captures it is waiting for
 * (gh-320), and this instrumentation does not read it yet — gh-277 is that half. What must hold meanwhile is
 * that a body it does not understand changes nothing at all: the ordering exists so the cloud can accept
 * before the agent sends, and it only works if the agent in the wild is genuinely unaffected.
 */
describe("Sender, against a cloud that answers with instructions it does not read yet", () => {
  const withCaptures = JSON.stringify({
    accepted: 1,
    inserted: 1,
    captures: [
      {
        id: "cap-1",
        environment: "test",
        method: "GET",
        route: "/checkout",
        windowSeconds: 60,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
  });

  it("clears the queue and reports success exactly as with an empty body", async () => {
    const { s, calls } = sender([202], quiet, withCaptures);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect(calls).toHaveLength(1);
    // Nothing dropped, nothing rejected: the same state an empty 202 leaves behind.
    expect([s.sent, s.dropped, s.rejected]).toEqual([1, 0, 0]);
  });

  it("does not send anything back because of it", async () => {
    const { s, calls } = sender([202, 202], quiet, withCaptures);
    s.enqueue(interval(1));
    await s.flush();
    s.enqueue(interval(2));
    await s.flush();
    // Two batches, two POSTs to the ingest path. An agent that had started acting on the instruction would
    // show up here as a third call, or as a different body.
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.url)).size).toBe(1);
  });

  it("is unmoved by a body it cannot parse at all", async () => {
    const { s } = sender([202], quiet, "this is not JSON");
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect([s.sent, s.dropped, s.rejected]).toEqual([1, 0, 0]);
  });
});

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

// gh-375. The queue is intervals, and `flush` returned early when it was empty — so a profile with no
// interval to ride on never left. The ADR 0017 says the profile hangs off the batch and not off an interval;
// its delivery did not.
//
// It went unnoticed because the only end-to-end look at a profile used a cloud that was switched off: with
// the sends failing, intervals piled up in the queue and the profile always found transport. The bug hides
// when the network is bad and shows when it is good.
describe("a profile with no interval to ride on", () => {
  const aProfile = () => ({
    start: Date.now() - 60_000,
    durationMs: 60_000,
    endpoints: [
      {
        method: "GET" as const,
        route: "/orders",
        operations: [{ kind: "query" as const, hash: "abc123", text: "SELECT ?", count: 1, totalMs: 1, errors: 0 }],
      },
    ],
  });

  it("travels on its own", async () => {
    const { s, calls } = sender([202]);
    s.enqueueProfile(aProfile());
    expect(await s.flush()).toBe(true);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as { profile?: unknown; intervals: unknown[] };
    expect(body.profile).toBeDefined();
    expect(body.intervals).toEqual([]);
  });

  it("still sends nothing when there is nothing", async () => {
    const { s, calls } = sender([202]);
    expect(await s.flush()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rides with the intervals when there are any, in one batch", async () => {
    const { s, calls } = sender([202]);
    s.enqueue(interval(1));
    s.enqueueProfile(aProfile());
    expect(await s.flush()).toBe(true);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as { profile?: unknown; intervals: unknown[] };
    expect(body.profile).toBeDefined();
    expect(body.intervals).toHaveLength(1);
  });
});

// gh-379. The orders travel in the ingest response (ADR 0071) and `flush` looked at `res.ok` and threw the
// body away: a contract with no receiver. This is the receiving end.
describe("the capture orders that come back in the answer", () => {
  const answer = (captures: unknown) => JSON.stringify({ accepted: 1, inserted: 1, captures });

  it("hands over what the cloud asked for", async () => {
    const seen: unknown[] = [];
    const { s } = sender([202], quiet, answer([{ id: "cap-1", windowSeconds: 60, expiresAt: "2025-11-24T16:00:00Z" }]));
    s.onCaptures = (pending) => seen.push(...pending);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: string }).id).toBe("cap-1");
  });

  it("does not care that an answer carries none", async () => {
    const seen: unknown[] = [];
    const { s } = sender([202], quiet, JSON.stringify({ accepted: 1, inserted: 1 }));
    s.onCaptures = (pending) => seen.push(...pending);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("treats a body it cannot read as no orders, and the batch still counts as sent", async () => {
    // The body is external input, and a cloud that answers nonsense must not cost the batch that did land.
    const seen: unknown[] = [];
    const { s } = sender([202], quiet, "not json at all");
    s.onCaptures = (pending) => seen.push(...pending);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("obeys the order as the cloud actually writes it, taken from the protocol's own fixture", async () => {
    // The parser used to require a number here and the contract has always said a date, so every order the
    // real cloud sent was dropped in silence. The body is not written here on purpose: it is the published
    // fixture, which is what the cloud emits (gh-398).
    const seen: PendingCapture[] = [];
    const { s } = sender([202], quiet, await fixture("one-capture.json"));
    s.onCaptures = (pending) => seen.push(...pending);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect(seen.map((c) => c.id)).toEqual(["5b6d1f0e-2c3a-4d5e-8f90-1a2b3c4d5e6f"]);
    expect(seen[0]?.expiresAt).toBe(Date.parse("2026-09-10T10:15:00Z"));
    expect(seen[0]?.route).toBe("/checkout");
  });

  it("reads every published answer without throwing, and finds the orders each one declares", async () => {
    // Enumerated from the protocol's fixture directory rather than from a list written here: a list written
    // here only covers what somebody remembered to put in it.
    for (const [name, body] of await allFixtures()) {
      const declared = (JSON.parse(body) as { captures?: unknown[] }).captures ?? [];
      const seen: PendingCapture[] = [];
      const { s } = sender([202], quiet, body);
      s.onCaptures = (pending) => seen.push(...pending);
      s.enqueue(interval(1));
      expect(await s.flush(), name).toBe(true);
      expect(seen.length, name).toBe(declared.length);
      for (const c of seen) expect(Number.isFinite(c.expiresAt), `${name}: ${c.id}`).toBe(true);
    }
  });

  it("drops an order whose deadline is not a date, and keeps the others in the same answer", async () => {
    const seen: PendingCapture[] = [];
    const { s } = sender(
      [202],
      quiet,
      answer([
        { id: "cap-bad", windowSeconds: 60, expiresAt: "tomorrow" },
        { id: "cap-good", windowSeconds: 60, expiresAt: "2099-01-01T00:00:00Z" },
      ]),
    );
    s.onCaptures = (pending) => seen.push(...pending);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect(seen.map((c) => c.id)).toEqual(["cap-good"]);
  });

  it("drops an order that is not shaped like one", async () => {
    const seen: unknown[] = [];
    const { s } = sender(
      [202],
      quiet,
      answer([{ id: 7 }, "nope", { id: "cap-2", windowSeconds: 30, expiresAt: "2099-01-01T00:00:00Z" }]),
    );
    s.onCaptures = (pending) => seen.push(...pending);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(true);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: string }).id).toBe("cap-2");
  });
});

/**
 * Every array a batch carries has a `maxItems` in the schema, and a batch past one is refused with a `400`, which
 * the sender drops whole (ADR 0035). So each queue behind one of those arrays has to stop at that number, and not
 * one before it.
 *
 * Three of them had no test at all, and taking any of the three caps out left every test green. With the
 * exceptions' gone, more than 32 signatures made every batch one the cloud refuses — and the `400` branch drops
 * each round's intervals and keeps the exceptions, so the next batch was refused the same way (gh-650).
 *
 * The numbers are the schema's, read from it and not copied. So is the list: a capped array the contract gains
 * without a way to overfill it here fails the first test, which is what a list written by hand cannot do.
 */
describe("Sender, bounded on every array a batch carries", () => {
  const properties: Record<string, Record<string, unknown>> = AGGREGATES_SCHEMA_V0.properties;
  const capped = Object.entries(properties).flatMap(([field, p]) =>
    p.type === "array" && typeof p.maxItems === "number" ? [{ field, max: p.maxItems }] : [],
  );

  const exception = (i: number): CountedException => ({ kind: "uncaught", hash: `h${i}`, text: "", count: 1 });
  const report = (i: number): CaptureProgress => ({ id: `cap-${i}`, startedAt: 1 });
  // The contract names one signal today and the queue keeps one ask per signal, so going past a cap of four takes
  // names it does not have. What this checks is the cap, which is there for the day it names a second.
  const ask = (i: number): LocalTrigger => ({ signal: `signal-${i}` as LocalTrigger["signal"], observedAt: 1 });

  /** One field of the batch as the cloud would receive it, without casting through an optional chain. */
  const carried = (call: { body: unknown } | undefined, field: string): unknown =>
    ((call?.body ?? {}) as Record<string, unknown>)[field];

  /** How to hand each queue `n` distinct entries. */
  const overfill: Record<string, (s: Sender, n: number) => void> = {
    intervals: (s, n) => {
      for (let i = 0; i < n; i++) s.enqueue(interval(i));
    },
    exceptions: (s, n) => s.enqueueExceptions(Array.from({ length: n }, (_, i) => exception(i))),
    captures: (s, n) => s.enqueueCaptures(Array.from({ length: n }, (_, i) => report(i))),
    triggers: (s, n) => s.enqueueTriggers(Array.from({ length: n }, (_, i) => ask(i))),
  };

  it("has a way to overfill every capped array the schema declares, and no other", () => {
    expect(capped.map((c) => c.field).sort()).toEqual(Object.keys(overfill).sort());
  });

  for (const { field, max } of capped) {
    it(`carries ${max} ${field}, the schema's maxItems, however many it was handed`, async () => {
      const { s, calls } = sender([202]);
      overfill[field]?.(s, max + 3);
      expect(await s.flush()).toBe(true);
      expect(carried(calls[0], field)).toHaveLength(max);
    });
  }

  it("sends a batch the schema accepts with every one of those queues past its cap", async () => {
    const { s, calls } = sender([202]);
    for (const { field, max } of capped) if (field !== "triggers") overfill[field]?.(s, max + 3);
    // The made-up signals above cannot be valid. Every signal the contract does name, asked for twice, is.
    const signals = AGGREGATES_SCHEMA_V0.$defs.LocalTrigger.properties.signal.enum;
    // `as` because the JSON module types the enum as `string[]`; the values are the schema's own.
    s.enqueueTriggers(
      [...signals, ...signals].map((signal) => ({ signal: signal as LocalTrigger["signal"], observedAt: 1 })),
    );
    expect(await s.flush()).toBe(true);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addKeyword("x-latency-boundaries-ms");
    ajv.addKeyword("x-calls-per-request-boundaries");
    ajv.addKeyword("x-ingest-path");
    ajv.addKeyword("x-since");
    const validate = ajv.compile(AGGREGATES_SCHEMA_V0);
    expect(validate(calls[0]?.body), JSON.stringify(validate.errors)).toBe(true);
    expect(carried(calls[0], "triggers")).toHaveLength(signals.length);
  });
});

/**
 * What the process threw outside a request, delivered so the cloud can apply it once (gh-625) and so nothing that
 * reaches the sender while a batch is in flight is lost when that batch lands (gh-626).
 *
 * Each delivery says, per signature, `count` —what happened since the last delivery this sender heard land— and
 * `total` —everything since the instance started—. `total - count` is what the sender knows was applied, which is
 * what lets the cloud recognise a resend: before, a delivery whose answer was lost went out again with its count
 * added to what came after, and nothing in it said which part the cloud already had.
 */
describe("Sender, delivering what the process threw", () => {
  const thrown = (hash: string, count: number): CountedException => ({ kind: "uncaught", hash, text: "", count });
  type Sent = { exceptions?: { hash: string; count: number; total?: number }[]; triggers?: LocalTrigger[] };

  /** A sender whose cloud answers each batch only when the test says so, which is what a batch in flight is. */
  function held() {
    const bodies: Sent[] = [];
    const answers: Array<(r: Response) => void> = [];
    const waiting: Array<{ n: number; resolve: () => void }> = [];
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Sent);
      for (const w of waiting) if (bodies.length >= w.n) w.resolve();
      return new Promise<Response>((resolve) => answers.push(resolve));
    }) as unknown as typeof fetch;
    const s = new Sender({
      url: "http://cloud.test",
      token: "tok",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl,
      now: () => 1_000_000,
    });
    /** Resolves once the cloud has received `n` batches: a flush reaches `fetch` a turn after it is called. */
    const requested = (n: number): Promise<"sent"> =>
      new Promise((resolve) => {
        if (bodies.length >= n) resolve("sent");
        else waiting.push({ n, resolve: () => resolve("sent") });
      });
    /** Answers the oldest request still waiting for one. */
    const answer = (status: number): void => answers.shift()?.(new Response(null, { status }));
    return { s, bodies, requested, answer };
  }
  const carried = (b: Sent | undefined) => (b?.exceptions ?? []).map((e) => [e.hash, e.count, e.total]);

  it("says with every delivery how many times a signature has happened since the instance started", async () => {
    const { s, calls } = sender([202, 202]);
    s.enqueueExceptions([thrown("a", 3)]);
    expect(await s.flush()).toBe(true);
    s.enqueueExceptions([thrown("a", 2), thrown("b", 1)]);
    expect(await s.flush()).toBe(true);
    expect(carried(calls[0]?.body as Sent)).toEqual([["a", 3, 3]]);
    expect(carried(calls[1]?.body as Sent)).toEqual([
      ["a", 2, 5],
      ["b", 1, 1],
    ]);
  });

  it("sends again what it never heard land with a total the cloud can recognise, and after it only what is new", async () => {
    // The answer was lost: the cloud may have stored the three. The retry says five in all, and five it has not
    // heard land, so a cloud that applied the three counts two and one that never saw them counts five.
    const { s, calls } = sender([new Error("The operation was aborted due to timeout"), 202, 202]);
    s.enqueueExceptions([thrown("a", 3)]);
    expect(await s.flush()).toBe(false);
    s.enqueueExceptions([thrown("a", 2)]);
    expect(await s.flush()).toBe(true);
    s.enqueueExceptions([thrown("a", 1)]);
    expect(await s.flush()).toBe(true);
    expect(calls.map((c) => carried(c.body as Sent))).toEqual([[["a", 3, 3]], [["a", 5, 5]], [["a", 1, 6]]]);
  });

  it("keeps what reached it while a batch was in flight, and sends it with the next one (gh-626)", async () => {
    const { s, bodies, requested, answer } = held();
    s.enqueueExceptions([thrown("a", 1)]);
    const first = s.flush();
    await requested(1);
    // In flight: what arrives now is for the next batch, and the sender says it cannot send one yet.
    s.enqueueExceptions([thrown("b", 4), thrown("a", 2)]);
    const ask: LocalTrigger = { signal: "event-loop-delay", observedAt: 1 };
    s.enqueueTriggers([ask]);
    expect(await s.flush()).toBe(false);
    answer(202);
    expect(await first).toBe(true);
    // Before gh-626 there was nothing left to send, and this flush said so at once: the first batch's landing had
    // emptied the exceptions and the asks, what it carried and what came after alike.
    const second = s.flush();
    expect(await Promise.race([second, requested(2)])).toBe("sent");
    answer(202);
    expect(await second).toBe(true);
    expect(carried(bodies[0])).toEqual([["a", 1, 1]]);
    // `a`'s count is what came after the batch that landed, and its total is everything.
    expect(carried(bodies[1])).toEqual([
      ["a", 2, 3],
      ["b", 4, 4],
    ]);
    expect(bodies[1]?.triggers).toEqual([ask]);
  });

  it("keeps totals for 256 signatures and sends the ones past them with none, which the contract accepts", async () => {
    // The bound is ADR 0179's: a key and a number per signature for the life of the process, and never an
    // eviction, because a total that started again under the same instance would read as already counted.
    const bound = 256;
    const { s, calls } = sender([]);
    for (let i = 0; i < bound; i += 32) {
      s.enqueueExceptions(Array.from({ length: 32 }, (_, j) => thrown(`h${i + j}`, 1)));
      expect(await s.flush()).toBe(true);
    }
    s.enqueueExceptions([thrown("past-the-bound", 2), thrown("h0", 1)]);
    expect(await s.flush()).toBe(true);
    const last = calls.at(-1)?.body as Sent;
    expect(carried(last)).toEqual([
      ["past-the-bound", 2, undefined],
      ["h0", 1, 2],
    ]);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addKeyword("x-latency-boundaries-ms");
    ajv.addKeyword("x-calls-per-request-boundaries");
    ajv.addKeyword("x-ingest-path");
    ajv.addKeyword("x-since");
    const validate = ajv.compile(AGGREGATES_SCHEMA_V0);
    expect(validate(last), JSON.stringify(validate.errors)).toBe(true);
  });
});
