import { channel } from "node:diagnostics_channel";
import { AGGREGATES_PATH, CAPTURE_EVIDENCE_SCHEMA_V0, type CaptureEvidence } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import { recordCall } from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";
import type { Logger } from "../src/log.ts";
import { PrearmRegister } from "../src/prearm.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * The sender's half of ADR 0215 (PR #941 made the contract and the cloud; this is the agent that fills the
 * fields): a row whose dependency list did not fit enters the evidence **marked**, and the coverage counts
 * the rows it carries. The mark is what a dependency capture matches on — a gap is not a proof that the
 * dependency was not used (invariant 14) — so a row that reached the evidence through its gap is a row the
 * evidence must not pass off as a complete one.
 */

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
ajv.addKeyword("x-error");
ajv.addKeyword("x-evidence-path");
// The one format the contract uses; ajv knows none on its own.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
const validateEvidence = ajv.compile(CAPTURE_EVIDENCE_SCHEMA_V0);

const REQUEST_START = "http.server.request.start";
const RESPONSE_FINISH = "http.server.response.finish";

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function testClock() {
  const real = () => performance.timeOrigin + performance.now();
  let at = real();
  return {
    now: () => at,
    /** Moves the agent's present forward, which is how a capture window closes with nobody waiting. */
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function config(url: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return testConfig(url, { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set(), ...extra });
}

/** A cloud that answers the first batch with the order and records every evidence it takes. */
function fakeCloud(evidence: unknown[], order: Record<string, unknown>) {
  let ordered = false;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith(AGGREGATES_PATH)) {
      // Asked once: the cloud repeats an order until it sees the start, and one is enough here.
      const captures = ordered ? [] : [order];
      ordered = true;
      return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
    }
    evidence.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

/** One order that watches the postgres this test's traffic either uses or only reaches through a gap. */
const postgresOrder = (id: string) => ({
  id,
  windowSeconds: 0.05,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  kind: "postgres",
  target: "db:5432",
});

/**
 * A request that touched nine distinct http hosts: the row's list holds eight, and the ninth is the gap the
 * mark says there is. The requests below are complete by contrast: they name the dependency they used.
 */
function heavyRequest(url: string): void {
  const request = { method: "GET", url };
  channel(REQUEST_START).publish({ request });
  for (let i = 0; i < 9; i += 1) recordCall("http", `svc-${i}:443`, 1);
  channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
}

/** The body the cloud took, checked against the contract: a mark the schema does not know is a refusal. */
function evidenceAt(evidence: unknown[], i: number): CaptureEvidence {
  const body = evidence[i] as CaptureEvidence;
  expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
  return body;
}

describe("the evidence marks the rows whose dependency list did not fit", () => {
  it("leaves a ring row marked when its list did not fit, and counts it", async () => {
    const evidence: unknown[] = [];
    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["http"]) }), {
      log: quiet,
      fetchImpl: fakeCloud(evidence, postgresOrder("cap-postgres")),
      now: clock.now,
    });
    cleanups.push(() => agent.stop());
    agent.start();

    // The row that touched more dependencies than the row holds: it enters the evidence only through its gap.
    heavyRequest("/orders");
    // The row whose list is complete: it uses the dependency the capture is about, and it says so plainly.
    const cart = { method: "GET", url: "/cart" };
    channel(REQUEST_START).publish({ request: cart });
    recordCall("postgres", "db:5432", 3);
    channel(RESPONSE_FINISH).publish({ request: cart, response: { statusCode: 200 } });

    expect(await agent.flushNow()).toBe(true);
    clock.advance(60);
    expect(await agent.flushNow()).toBe(true);

    expect(evidence).toHaveLength(1);
    const body = evidenceAt(evidence, 0);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toMatchObject({ method: "GET", route: "/orders", dependenciesTruncated: true });
    // The complete row does not say what it never lost: absent means false, and a false on every request
    // would pay for the normal case to say nothing (ADR 0215).
    expect(body.requests[1]).toMatchObject({ method: "GET", route: "/cart" });
    expect(body.requests[1]?.dependenciesTruncated).toBeUndefined();
    expect(body.coverage.dependenciesTruncated).toBe(1);
  });

  it("leaves a reserve row marked when its list did not fit, and counts it", async () => {
    const evidence: unknown[] = [];
    const clock = testClock();
    const prearm = new PrearmRegister();
    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["http"]) }), {
      log: quiet,
      fetchImpl: fakeCloud(evidence, postgresOrder("cap-postgres-reserve")),
      now: clock.now,
      // A ring of eight: the traffic below wraps it, which is how the ring loses the armed route's row.
      fine: new FineRegister({ requests: 8 }),
      prearm,
    });
    cleanups.push(() => agent.stop());
    // Armed before the request, which is the only order in which a reserve can hold anything.
    prearm.arm("GET /cart", clock.now() - 1_000, 60_000);
    agent.start();

    // The armed route's request touched more dependencies than the row holds: the gap is what matches it.
    heavyRequest("/cart");
    // Traffic from a route nobody armed, enough to wrap the small ring and take the cart row with it.
    for (let i = 0; i < 20; i += 1) {
      const other = { method: "GET", url: `/items/${i}` };
      channel(REQUEST_START).publish({ request: other });
      channel(RESPONSE_FINISH).publish({ request: other, response: { statusCode: 200 } });
    }

    expect(await agent.flushNow()).toBe(true);
    clock.advance(60);
    expect(await agent.flushNow()).toBe(true);

    expect(evidence).toHaveLength(1);
    const body = evidenceAt(evidence, 0);
    // The row the ring no longer holds, brought by the reserve — and still marked, not made complete on the
    // way (ADR 0215): the reserve kept the same mark the ring kept, and the evidence keeps it as well.
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ method: "GET", route: "/cart", dependenciesTruncated: true });
    expect(body.coverage.dependenciesTruncated).toBe(1);
  });

  it("says nothing when no row's list was truncated, and omits the counter with it", async () => {
    const evidence: unknown[] = [];
    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["http"]) }), {
      log: quiet,
      fetchImpl: fakeCloud(evidence, postgresOrder("cap-postgres-quiet")),
      now: clock.now,
    });
    cleanups.push(() => agent.stop());
    agent.start();

    for (let i = 0; i < 2; i += 1) {
      const cart = { method: "GET", url: "/cart" };
      channel(REQUEST_START).publish({ request: cart });
      recordCall("postgres", "db:5432", 3);
      channel(RESPONSE_FINISH).publish({ request: cart, response: { statusCode: 200 } });
    }

    expect(await agent.flushNow()).toBe(true);
    clock.advance(60);
    expect(await agent.flushNow()).toBe(true);

    expect(evidence).toHaveLength(1);
    const body = evidenceAt(evidence, 0);
    expect(body.requests).toHaveLength(2);
    for (const r of body.requests) expect(r.dependenciesTruncated).toBeUndefined();
    // The zero is omitted, as `shed` is when there was no shedding in the window: a counter of zero says
    // nothing, and the evidence that says nothing keeps the shape of the evidence of before the field.
    expect(body.coverage.dependenciesTruncated).toBeUndefined();
    expect(Object.keys(body.coverage).sort()).toEqual([
      "attachedRequests",
      "detailLost",
      "observedRequests",
      "truncated",
    ]);
  });

  it("marks the rows of a route capture the same way", async () => {
    // A capture of a route matches on the template, not on a dependency — but the rows it carries are the
    // same rows, and the same gap says the same thing in their evidence: the mapping is one, not two.
    const evidence: unknown[] = [];
    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["http"]) }), {
      log: quiet,
      fetchImpl: fakeCloud(evidence, {
        id: "cap-route",
        windowSeconds: 0.05,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        method: "GET",
        route: "/orders",
      }),
      now: clock.now,
    });
    cleanups.push(() => agent.stop());
    agent.start();

    heavyRequest("/orders");

    expect(await agent.flushNow()).toBe(true);
    clock.advance(60);
    expect(await agent.flushNow()).toBe(true);

    expect(evidence).toHaveLength(1);
    const body = evidenceAt(evidence, 0);
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ method: "GET", route: "/orders", dependenciesTruncated: true });
    expect(body.coverage.dependenciesTruncated).toBe(1);
  });
});
