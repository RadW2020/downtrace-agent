import { AGGREGATES_PATH, CAPTURE_EVIDENCE_SCHEMA_V0, type CaptureEvidence } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { OverheadMeter, Sheddable } from "../src/overhead.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * ADR 0210, the half ADR 0008 left for after the cloud: when the meter itself decided to give up the fine
 * detail, the evidence says how long that lasted inside the window and why — and only that. Absent is the
 * declaration of «the evidence does not say»: no shedding, the configuration's floor, or an older sender.
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

const quiet = { warn: () => {}, debug: () => {} };
/** The window the orders ask for, in milliseconds. */
const WINDOW_MS = 50;

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

/**
 * The meter as a test drives it: its clock is a variable, and one request is one hook that costs `cost` ms
 * plus the close of the request. A window of one request so every request re-decides, and the meter's own
 * budget: over it sheds, under half of it recovers.
 */
function driveMeter(floor?: (typeof Sheddable)[keyof typeof Sheddable]) {
  let clock = 0;
  const m = new OverheadMeter({
    sampleEvery: 1,
    windowRequests: 1,
    budgetMs: 0.5,
    ...(floor === undefined ? {} : { floor }),
    now: () => clock,
  });
  const request = (cost: number): void => {
    const started = m.enter();
    clock += cost;
    m.leave(started);
    m.requestFinished();
  };
  return { m, request, tick: (ms: number) => (clock += ms) };
}

/**
 * A cloud that answers every batch with the orders `orders` gives for that batch (the first is 1), and
 * records every evidence it takes, in the order it took it.
 */
function fakeCloud(evidence: CaptureEvidence[], orders: (batch: number) => Record<string, unknown>[]) {
  let batch = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith(AGGREGATES_PATH)) {
      batch += 1;
      return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures: orders(batch) }), { status: 202 });
    }
    evidence.push(JSON.parse(String(init?.body)) as CaptureEvidence);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

const captureOrder = (id: string, windowMs: number) => ({
  id,
  windowSeconds: windowMs / 1000,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

function agentWith(
  evidence: CaptureEvidence[],
  meter: ReturnType<typeof driveMeter>,
  orders: (batch: number) => Record<string, unknown>[],
) {
  const clock = testClock();
  const agent = createAgent(
    testConfig("http://cloud.invalid", {
      environment: "test",
      version: "t1",
      intervalMs: 60_000,
      instrument: new Set(),
    }),
    {
      log: quiet,
      fetchImpl: fakeCloud(evidence, orders),
      now: clock.now,
      // The meter with the injected clock the ticket asks for: the test drives its shedding and its time.
      overhead: meter.m,
    },
  );
  cleanups.push(() => agent.stop());
  agent.start();
  // Something to say without traffic: a process error. The order arrives in the answer to that batch, and no
  // request of the application's has to run for the capture to be asked.
  agent.report({ error: new Error("a process error"), kind: "explicit" });
  return { agent, clock };
}

/** The batch that carries the order, and the accept it brings with it. */
async function acceptOnce(agent: ReturnType<typeof createAgent>): Promise<void> {
  expect(await agent.flushNow()).toBe(true);
}

describe("the evidence says when the fine detail was not being written", () => {
  it("carries the shed of a latency episode that ran inside the window and recovered before the end", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter();
    const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
    await acceptOnce(agent);
    // The episode: an over-budget request sheds the fine detail for 1500.2 ms, and a cheap one takes it
    // back before the window closes.
    meter.request(0.8);
    meter.tick(1500.2);
    meter.request(0);
    clock.advance(WINDOW_MS);
    expect(await agent.flushNow()).toBe(true);
    expect(evidence).toHaveLength(1);
    const body = evidence[0] as CaptureEvidence;
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
    expect(body.coverage.shed).toEqual({ ms: 1501, reason: "latency" });
  });

  it("carries only the window's part of a shed that began before the capture and is still running at its end", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter();
    // The shed is already under way before the capture exists: 100 ms of it precede the start.
    meter.request(0.8);
    meter.tick(100);
    const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
    await acceptOnce(agent);
    // The window passes with the shed still running: the meter's clock advances the window's length, nothing more.
    meter.tick(WINDOW_MS);
    clock.advance(WINDOW_MS);
    expect(await agent.flushNow()).toBe(true);
    const body = evidence[0] as CaptureEvidence;
    // The window's length, rounded up, and not the 100 ms that ran before the capture began.
    expect(body.coverage.shed).toEqual({ ms: WINDOW_MS, reason: "latency" });
  });

  it("says nothing when the shed began and ended before the capture began", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter();
    meter.request(0.8);
    meter.tick(100);
    meter.request(0);
    const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
    await acceptOnce(agent);
    meter.tick(WINDOW_MS);
    clock.advance(WINDOW_MS);
    expect(await agent.flushNow()).toBe(true);
    const body = evidence[0] as CaptureEvidence;
    expect(body.coverage.shed).toBeUndefined();
  });

  it("adds the episodes of a window and keeps the reason in force when it ended", async () => {
    // Memory first, then latency: the sum of both, and the last reason is the latency's.
    {
      const evidence: CaptureEvidence[] = [];
      const meter = driveMeter();
      const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
      await acceptOnce(agent);
      meter.m.shedForMemory();
      meter.tick(20);
      meter.request(0);
      meter.request(0.8);
      meter.tick(30);
      meter.request(0);
      clock.advance(WINDOW_MS);
      expect(await agent.flushNow()).toBe(true);
      expect(evidence[0]?.coverage.shed).toEqual({ ms: 50, reason: "latency" });
    }
    // The reverse order: the same sum, and the last reason is the memory's.
    {
      const evidence: CaptureEvidence[] = [];
      const meter = driveMeter();
      const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-2", WINDOW_MS)] : []));
      await acceptOnce(agent);
      meter.request(0.8);
      meter.tick(30);
      meter.request(0);
      meter.m.shedForMemory();
      meter.tick(20);
      meter.request(0);
      clock.advance(WINDOW_MS);
      expect(await agent.flushNow()).toBe(true);
      expect(evidence[0]?.coverage.shed).toEqual({ ms: 50, reason: "memory" });
    }
  });

  it("rounds a fraction of a millisecond up to one, and never sends zero", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter();
    const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
    await acceptOnce(agent);
    meter.request(0.8);
    meter.tick(0.2);
    meter.request(0);
    clock.advance(WINDOW_MS);
    expect(await agent.flushNow()).toBe(true);
    const body = evidence[0] as CaptureEvidence;
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
    expect(body.coverage.shed).toEqual({ ms: 1, reason: "latency" });
    // The schema is the backstop: an `ms` of 0 is not a shed, it is a refusal of the whole evidence.
    const invalid = { ...body, coverage: { ...body.coverage, shed: { ms: 0, reason: "latency" } } };
    expect(validateEvidence(invalid)).toBe(false);
  });

  it("says nothing when the floor holds the fine detail, whatever the meter does above it", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter(Sheddable.Fine);
    const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
    await acceptOnce(agent);
    // The meter still sheds above the floor when the hooks cost too much: one more level, for latency. That
    // fine detail was never its own to keep, so it is never its own to time.
    meter.request(0.8);
    meter.request(0.8);
    meter.tick(1_000);
    clock.advance(WINDOW_MS);
    expect(await agent.flushNow()).toBe(true);
    const body = evidence[0] as CaptureEvidence;
    expect(meter.m.state().shed).toBe(Sheddable.Profile);
    expect(body.coverage.shed).toBeUndefined();
  });

  it("is identical to the evidence of today when there was no shed in the window", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter();
    const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
    await acceptOnce(agent);
    clock.advance(WINDOW_MS);
    expect(await agent.flushNow()).toBe(true);
    const body = evidence[0] as CaptureEvidence;
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
    expect(Object.keys(body.coverage).sort()).toEqual([
      "attachedRequests",
      "detailLost",
      "observedRequests",
      "truncated",
    ]);
    expect(body.coverage.shed).toBeUndefined();
  });

  it("gives each of two overlapping captures only the shed of its own window", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter();
    // One order, two windows: the short one closes while the long one is still open.
    const orders = (b: number) =>
      b === 1 ? [captureOrder("cap-a", WINDOW_MS), captureOrder("cap-b", WINDOW_MS * 3)] : [];
    const { agent, clock } = agentWith(evidence, meter, orders);
    await acceptOnce(agent);
    // The first episode runs inside cap-a's window.
    meter.request(0.8);
    meter.tick(5);
    meter.request(0);
    clock.advance(WINDOW_MS);
    expect(await agent.flushNow()).toBe(true);
    // cap-a is out; cap-b is still watching, and the second episode runs inside its window only.
    meter.request(0.8);
    meter.tick(3);
    meter.request(0);
    clock.advance(WINDOW_MS * 2);
    // No batch to say this time — both starts rode the last one — but the evidence goes out anyway: a
    // window closing does not wait for something else to say.
    expect(await agent.flushNow()).toBe(false);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.coverage.shed).toEqual({ ms: 5, reason: "latency" });
    expect(evidence[1]?.coverage.shed).toEqual({ ms: 8, reason: "latency" });
  });

  it("carries the shed to the end of a capture the process leaves with", async () => {
    const evidence: CaptureEvidence[] = [];
    const meter = driveMeter();
    const { agent, clock } = agentWith(evidence, meter, (b) => (b === 1 ? [captureOrder("cap-1", WINDOW_MS)] : []));
    await acceptOnce(agent);
    // The shed is under way and never recovers: the process leaves instead.
    meter.request(0.8);
    meter.tick(30);
    clock.advance(WINDOW_MS);
    await agent.stop();
    expect(evidence).toHaveLength(1);
    const body = evidence[0] as CaptureEvidence;
    expect(body.coverage.shed).toEqual({ ms: 30, reason: "latency" });
  });
});
