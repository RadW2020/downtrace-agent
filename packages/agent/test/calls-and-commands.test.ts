import { channel, tracingChannel } from "node:diagnostics_channel";
import {
  AGGREGATES_PATH,
  AGGREGATES_SCHEMA_V0,
  type AggregatesBatch,
  CAPTURE_EVIDENCE_SCHEMA_V0,
  type CaptureEvidence,
  type Operation,
} from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import { hash64 } from "../src/fingerprint.ts";
import type { Logger } from "../src/log.ts";
import { withheldName } from "../src/minimal.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * DT-17, end to end: an outgoing call and a Redis command are operations of the route that ran them, in the
 * profile and in the black box, and the evidence names the kind of every operation it carries (ADR 0219). The
 * observers are the real ones, driven through the very channels undici and ioredis publish on, and what is
 * asked is what the cloud would take: the bytes of the batch and of the evidence.
 */

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
ajv.addKeyword("x-error");
ajv.addKeyword("x-evidence-path");
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
const validateBatch = ajv.compile(AGGREGATES_SCHEMA_V0);
const validateEvidence = ajv.compile(CAPTURE_EVIDENCE_SCHEMA_V0);

const REQUEST_START = "http.server.request.start";
const RESPONSE_FINISH = "http.server.response.finish";
const redis = tracingChannel("ioredis:command");

/** What a key or an argument may carry, and none of which may leave the process (invariant 5). */
const SECRETS = ["ana@cliente.com", "session:", "zz-secret-77", "cart:"];

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function testClock() {
  let at = performance.timeOrigin + performance.now();
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

interface Run {
  batches: string[];
  evidence: string[];
}

/**
 * One request to `POST /checkout` that makes two concurrent calls to Stripe, a `GET` and an `HGETALL` against
 * its cache, and reports an error it handled; a capture of the route, ordered in the answer to the first batch;
 * and the agent stopped, which drains the profile (gh-371).
 */
async function checkout(over: Partial<AgentConfig> = {}): Promise<Run> {
  const run: Run = { batches: [], evidence: [] };
  const minimal = over.minimal === true;
  let ordered = false;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = String(init?.body);
    if (String(url).endsWith(AGGREGATES_PATH)) {
      run.batches.push(body);
      const captures = ordered
        ? []
        : [
            {
              id: "cap-checkout",
              windowSeconds: 0.05,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              method: "POST",
              // The cloud knows the route by the name that left the process.
              route: minimal ? withheldName("/checkout") : "/checkout",
            },
          ];
      ordered = true;
      return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
    }
    run.evidence.push(body);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  const clock = testClock();
  const agent = createAgent(
    testConfig("http://cloud.invalid", {
      environment: "test",
      version: "t1",
      intervalMs: 60_000,
      instrument: new Set(["http", "redis"]),
      ...over,
    }),
    { log: quiet, fetchImpl, now: clock.now },
  );
  cleanups.push(() => agent.stop());
  agent.start();

  const request = { method: "POST", url: "/checkout" };
  channel(REQUEST_START).publish({ request });
  // Two calls in flight at once, as undici publishes them: the second starts before the first ends, and ends first.
  const first = { origin: "https://api.stripe.com", method: "POST", path: "/v1/charges?customer=zz-secret-77" };
  const second = { origin: "https://api.stripe.com", method: "POST", path: "/v1/charges?customer=zz-secret-77" };
  channel("undici:request:create").publish({ request: first });
  await pause(2);
  channel("undici:request:create").publish({ request: second });
  await pause(2);
  channel("undici:request:headers").publish({ request: second, response: { statusCode: 200 } });
  await pause(2);
  channel("undici:request:headers").publish({ request: first, response: { statusCode: 200 } });
  // And the cache, as ioredis publishes it: the command's name as the application called it, and its key.
  await redis.tracePromise(async () => "v", {
    command: "get",
    args: ["session:ana@cliente.com"],
    serverAddress: "cache",
    serverPort: 6379,
  });
  await redis.tracePromise(async () => ({}), {
    command: "hgetall",
    args: ["cart:zz-secret-77"],
    serverAddress: "cache",
    serverPort: 6379,
  });
  agent.report({ kind: "explicit", error: new Error("the coupon was refused") });
  channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });

  expect(await agent.flushNow()).toBe(true);
  clock.advance(60);
  expect(await agent.flushNow()).toBe(true);
  await agent.stop();
  return run;
}

function batchesOf(run: Run): AggregatesBatch[] {
  return run.batches.map((body) => {
    const batch = JSON.parse(body) as AggregatesBatch;
    expect(validateBatch(batch), ajv.errorsText(validateBatch.errors)).toBe(true);
    return batch;
  });
}

function evidenceOf(run: Run): CaptureEvidence {
  expect(run.evidence).toHaveLength(1);
  const evidence = JSON.parse(run.evidence[0] ?? "{}") as CaptureEvidence;
  expect(validateEvidence(evidence), ajv.errorsText(validateEvidence.errors)).toBe(true);
  return evidence;
}

/** What `POST /checkout` ran, across every profile the run sent. */
function profiled(run: Run, route = "/checkout"): Operation[] {
  return batchesOf(run).flatMap(
    (b) =>
      b.profile?.endpoints.filter((e) => e.method === "POST" && e.route === route).flatMap((e) => e.operations) ?? [],
  );
}

describe("an outgoing call and a Redis command, from the channel to the wire", () => {
  it("puts two concurrent calls in the evidence as two operations `call` that overlap", async () => {
    const evidence = evidenceOf(await checkout());
    const [request] = evidence.requests;
    const calls = request?.operations.filter((o) => o.kind === "call") ?? [];
    expect(calls).toHaveLength(2);
    const [a, b] = [...calls].sort((x, y) => x.startMs - y.startMs);
    expect(a && b && b.startMs < a.endMs, "the second started before the first ended").toBe(true);
    expect(a?.hash).toBe(b?.hash);
  });

  // The contract: «what it ran, in the order it started them». An operation is written when it ends, and two calls
  // in flight end in whatever order the network says: the one that started second ended first here.
  it("lists a request's operations in the order they started, not the order they ended", async () => {
    const evidence = evidenceOf(await checkout());
    for (const request of evidence.requests) {
      const starts = request.operations.map((o) => o.startMs);
      expect(starts).toEqual([...starts].sort((x, y) => x - y));
    }
  });

  it("names the kind of every operation the evidence carries, the error's and the commands' as well", async () => {
    const evidence = evidenceOf(await checkout());
    const operations = [
      ...evidence.requests.flatMap((r) => r.operations),
      ...(evidence.reference?.samples.flatMap((s) => s.operations) ?? []),
    ];
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) expect(operation.kind, JSON.stringify(operation)).toBeDefined();
    expect(evidence.requests[0]?.operations.map((o) => o.kind)).toEqual([
      "call",
      "call",
      "command",
      "command",
      "explicit",
    ]);
  });

  it("puts the call in the route's profile once, run twice, with its method and host", async () => {
    const operations = profiled(await checkout());
    const calls = operations.filter((o) => o.kind === "call");
    expect(calls).toEqual([expect.objectContaining({ text: "POST api.stripe.com", count: 2, errors: 0 })]);
    expect(calls[0]?.hash).toBe(hash64("POST api.stripe.com"));
  });

  it("puts the two commands in the profile by name and server, and no key or argument anywhere", async () => {
    const run = await checkout();
    const commands = profiled(run).filter((o) => o.kind === "command");
    expect(commands.map((o) => o.text).sort()).toEqual(["GET cache:6379", "HGETALL cache:6379"]);
    // The sweep: every byte that would leave, the batches and the evidence.
    for (const body of [...run.batches, ...run.evidence]) {
      for (const secret of SECRETS) expect(body, `«${secret}» reached the wire`).not.toContain(secret);
      expect(body, "a path reached the wire").not.toContain("/v1/charges");
    }
  });

  it("sends the operations without text in minimal mode, and names no host anywhere", async () => {
    const run = await checkout({ minimal: true });
    const operations = profiled(run, withheldName("/checkout"));
    const call = operations.find((o) => o.kind === "call");
    expect(call).toBeDefined();
    expect(call?.count).toBe(2);
    for (const operation of operations) expect(operation.text, JSON.stringify(operation)).toBeUndefined();
    // The hash is a digest of the withheld name, so the analysis still groups and the host is not hashed bare.
    expect(call?.hash).toBe(hash64(`POST ${withheldName("api.stripe.com")}`));
    for (const body of [...run.batches, ...run.evidence]) {
      for (const theirs of ["stripe", "cache:6379", ...SECRETS]) expect(body).not.toContain(theirs);
    }
    // And the capture still carries the calls, by hash and kind.
    expect(evidenceOf(run).requests[0]?.operations.filter((o) => o.kind === "call")).toHaveLength(2);
  });

  it("leaves no operation and no counter of a host the operator excluded", async () => {
    const run = await checkout({ excludeDependencies: ["api.stripe.com"] });
    const operations = profiled(run);
    expect(operations.filter((o) => o.kind === "call")).toEqual([]);
    // What was not excluded is still there: the exclusion is a choice, not a blindness.
    expect(operations.filter((o) => o.kind === "command")).toHaveLength(2);
    const dependencies = batchesOf(run).flatMap((b) =>
      b.intervals.flatMap((i) => i.endpoints.flatMap((e) => e.dependencies ?? [])),
    );
    expect(dependencies.map((d) => d.kind).sort()).toEqual(["redis"]);
    expect(evidenceOf(run).requests[0]?.operations.some((o) => o.kind === "call")).toBe(false);
    for (const body of [...run.batches, ...run.evidence]) expect(body).not.toContain("stripe");
  });
});
