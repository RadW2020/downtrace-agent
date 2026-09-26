import { channel, tracingChannel } from "node:diagnostics_channel";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AGGREGATES_PATH,
  AGGREGATES_SCHEMA_V0,
  type AggregatesBatch,
  CAPTURE_EVIDENCE_SCHEMA_V0,
  type Interval,
} from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, createAgent } from "../src/agent.ts";
import { IntervalAggregator, type Recorder } from "../src/aggregator.ts";
import type { AgentConfig, Instrument } from "../src/config.ts";
import { currentContext, recordOperationIn } from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";
import type { Logger } from "../src/log.ts";
import { RuntimeSampler } from "../src/runtime.ts";
import { testConfig } from "./support/agent-config.ts";
import { escapedFrom } from "./support/escaped.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
ajv.addKeyword("x-evidence-path");
// The one format the contract uses; ajv knows none on its own.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);
const validateEvidence = ajv.compile(CAPTURE_EVIDENCE_SCHEMA_V0);

/** In-process stand-in for the cloud: captures batches, answers with a configurable status. */
async function startSink(status = 202) {
  const batches: AggregatesBatch[] = [];
  const state = { status };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === AGGREGATES_PATH && state.status < 400)
        batches.push(JSON.parse(body) as AggregatesBatch);
      res.writeHead(state.status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, batches, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function startApp() {
  const app = express();
  app.get("/products", (_req, res) => {
    res.json([]);
  });
  app.get("/products/:id", (req, res) => {
    res.json({ id: req.params.id });
  });
  app.get("/boom", (_req, res) => {
    res.status(500).json({ error: "boom" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function config(url: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return testConfig(url, { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set(), ...extra });
}

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function hit(url: string, path: string): Promise<number> {
  const res = await fetch(url + path);
  await res.arrayBuffer();
  return res.status;
}

/**
 * The agent's clock, driven from here. Absolute milliseconds and derived from `performance`, which is what
 * `AgentDeps.now` promises and what the fine register dates requests with (ADR 0107).
 *
 * It replaces six `setTimeout`s. Three of them were waiting for the scheduler to separate two instants that
 * came from two different clocks, and one of those three had already been widened once for the same reason —
 * which is a sleep bought twice to hide a mismatch in production code, not a slow test (gh-538). The other
 * three were waiting for a capture window to close, and a window closes when the clock says so.
 */
function testClock() {
  const real = () => performance.timeOrigin + performance.now();
  let at = real();
  return {
    now: () => at,
    /** Moves the agent's present forward, which is how a capture window closes with nobody waiting. */
    advance: (ms: number) => {
      at += ms;
    },
    /**
     * Puts the agent's present at the real instant of this line. Everything published before it is strictly
     * earlier and everything after is strictly later — in the agent's own clock, which is the only one that
     * can order them.
     */
    here: () => {
      at = real();
    },
  };
}

describe("agent v0 (integration)", () => {
  it("aggregates 100 Express requests into one valid batch with 3 normalised endpoints", async () => {
    const sink = await startSink();
    const app = await startApp();
    const agent = createAgent(config(sink.url), { log: quiet });
    cleanups.push(() => agent.stop(), app.close, sink.close);
    agent.start();

    for (let i = 0; i < 40; i++) await hit(app.url, "/products");
    for (let i = 1; i <= 50; i++) await hit(app.url, `/products/${i}`);
    for (let i = 0; i < 10; i++) expect(await hit(app.url, "/boom")).toBe(500);

    expect(await agent.flushNow()).toBe(true);
    expect(sink.batches).toHaveLength(1);
    const batch = sink.batches[0] as AggregatesBatch;
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    expect(batch.agent).toMatchObject({ name: "@downtrace/agent", runtime: "node", runtimeVersion: process.version });
    // What was watched travels with the batch, in a batch the schema accepted above (gh-180, COB-01). This
    // agent asks for nothing, so all four are `off` — and saying so is the point: silence would mean «this
    // sender did not tell us», which is what an instrumentation older than 0.7.0 says.
    expect(batch.agent.observers).toEqual({ pg: "off", http: "off", redis: "off", runtime: "off" });
    expect(batch.deploy).toEqual({ version: "t1", environment: "test" });
    expect(batch.instance.pid).toBe(process.pid);

    const [interval] = batch.intervals as [Interval];
    const byRoute = new Map(interval.endpoints.map((e) => [e.route, e]));
    expect([...byRoute.keys()].sort()).toEqual(["/boom", "/products", "/products/:id"]);
    expect(interval.endpoints.reduce((n, e) => n + e.count, 0)).toBe(100);
    expect(byRoute.get("/products/:id")?.count).toBe(50);
    expect(byRoute.get("/boom")).toMatchObject({ count: 10, errors: 10, status: { serverError: 10 } });
    for (const e of interval.endpoints) {
      expect(e.latency.counts.reduce((a, b) => a + b, 0)).toBe(e.count);
      expect(e.latency.max).toBeGreaterThan(0);
    }
    // The sink lives in this process, so the agent also observes its own POST to it (known limitation).
    expect(agent.stats.recorded).toBeGreaterThanOrEqual(100);
  });

  it("groups identifier-looking segments without a framework", async () => {
    const sink = await startSink();
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const agent = createAgent(config(sink.url), { log: quiet });
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );
    agent.start();

    await hit(url, "/users/42");
    await hit(url, "/users/7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d");
    await hit(url, "/users/507f1f77bcf86cd799439011");
    await agent.flushNow();
    const endpoints = sink.batches[0]?.intervals[0]?.endpoints ?? [];
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({ method: "GET", route: "/users/:id", count: 3 });
  });

  it("survives a failing or missing cloud: bounded queue, app unaffected, nothing thrown", async () => {
    const sink = await startSink(500);
    const app = await startApp();
    const agent = createAgent(config(sink.url), { log: quiet });
    cleanups.push(() => agent.stop(), app.close, sink.close);
    agent.start();

    for (let i = 0; i < 10; i++) {
      expect(await hit(app.url, "/products")).toBe(200);
      expect(await agent.flushNow()).toBe(false);
    }
    expect(agent.stats.pending).toBeLessThanOrEqual(6);
    expect(agent.stats.failed).toBe(10);

    await sink.close();
    cleanups.splice(cleanups.indexOf(sink.close), 1);
    expect(await hit(app.url, "/products")).toBe(200);
    expect(await agent.flushNow()).toBe(false);
    expect(agent.stats.pending).toBeLessThanOrEqual(6);
    expect(agent.stats.internalErrors).toBe(0);
    expect(agent.stats.disabled).toBe(false);
  });

  it("disables itself after 10 internal errors and leaves the app untouched", async () => {
    const sink = await startSink();
    const app = await startApp();
    const warnings: string[] = [];
    const faulty: Recorder = {
      record: () => {
        throw new Error("injected");
      },
      rotate: () => null,
    };
    const agent = new Agent(config(sink.url), {
      recorder: faulty,
      log: { warn: (m) => warnings.push(m), debug: () => {} },
    });
    cleanups.push(() => agent.stop(), app.close, sink.close);
    agent.start();

    for (let i = 0; i < 12; i++) expect(await hit(app.url, "/products")).toBe(200);
    expect(agent.stats.internalErrors).toBe(10);
    expect(agent.stats.disabled).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/disabled after 10 internal errors/);
    expect(await hit(app.url, "/products")).toBe(200);
  });

  it("does not subscribe or send anything when never started", async () => {
    const sink = await startSink();
    const app = await startApp();
    const agent = createAgent(config(sink.url), { log: quiet, recorder: new IntervalAggregator({ now: () => 1_000 }) });
    cleanups.push(app.close, sink.close);
    await hit(app.url, "/products");
    expect(agent.stats.recorded).toBe(0);
    expect(await agent.flushNow()).toBe(false);
    expect(sink.batches).toHaveLength(0);
  });

  it("announces each observer once, so its own log can be trusted", async () => {
    // The pg line used to appear twice: instrumentPg writes it, and the agent wrote it again from the returned
    // version. Nothing was instrumented twice — the symbol guard sees to that — but the log said it was, and a
    // log that lies sends whoever reads it looking for a problem that is not there.
    const sink = await startSink();
    const lines: string[] = [];
    const agent = new Agent(config(sink.url, { instrument: new Set(["pg"]) }), {
      log: { warn: (m) => lines.push(m), debug: (m) => lines.push(m) },
    });
    cleanups.push(() => agent.stop(), sink.close);
    agent.start();

    // Exactly one: zero would mean the observer never ran and the test proves nothing.
    expect(lines.filter((l) => l.includes("instrumented pg"))).toHaveLength(1);
  });
  // gh-371: a process that lives less than a minute used to send no profile at all. The window is 60 s and
  // shutting down did not change the clock, so everything the instrumentation had learned about what the
  // routes run went with it — and a process that keeps restarting is exactly when that matters.
  it("sends the profile of a process that did not live a whole minute", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const sink = await startSink();
    const agent = createAgent(config(sink.url, { instrument: new Set(["pg"]) }), { log: quiet });
    cleanups.push(sink.close);
    agent.start();

    // The same message shape the diagnostics channel publishes, with a query recorded inside the request.
    const request = { method: "GET", url: "/products/7" };
    channel(REQUEST_START).publish({ request });
    const ctx = currentContext();
    expect(ctx, "the agent should have opened a context for the request").toBeDefined();
    if (ctx) {
      recordOperationIn(ctx, {
        kind: "query",
        fingerprint: { hash: "abc123", text: "SELECT id FROM products WHERE id = ?" },
        startedAt: 0,
        endedAt: 2,
      });
    }
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });

    // Ten seconds of life, not sixty.
    await agent.stop();

    const withProfile = sink.batches.find((b) => b.profile !== undefined);
    expect(withProfile, "the profile went with the process").toBeDefined();
    const operation = withProfile?.profile?.endpoints[0]?.operations[0];
    expect(operation?.hash).toBe("abc123");
    // And it says how partial it was rather than claiming a minute it did not have.
    expect(withProfile?.profile?.durationMs).toBeLessThan(60_000);
  });

  // The other half of gh-371, and the one a mutation slipped past first: draining is for leaving, not for
  // every interval. Doing it on each flush would put the profile back on the aggregates' cadence, and the
  // arithmetic of ADR 0017 says that does not fit in the row budget by nearly double.
  it("does not send a partial profile just because an interval ended", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const sink = await startSink();
    const agent = createAgent(config(sink.url, { instrument: new Set(["pg"]) }), { log: quiet });
    cleanups.push(() => agent.stop(), sink.close);
    agent.start();

    const request = { method: "GET", url: "/products/7" };
    channel(REQUEST_START).publish({ request });
    const ctx = currentContext();
    if (ctx) {
      recordOperationIn(ctx, {
        kind: "query",
        fingerprint: { hash: "abc123", text: "SELECT id FROM products WHERE id = ?" },
        startedAt: 0,
        endedAt: 2,
      });
    }
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });

    expect(await agent.flushNow()).toBe(true);
    expect(
      sink.batches.some((b) => b.profile !== undefined),
      "the window was not up",
    ).toBe(false);
  });
  // gh-379: the loop closes. The cloud asks in the answer to a batch (ADR 0071), this process starts
  // watching, says so in the next batch (ADR 0098) and sends the evidence when the window shuts (ADR 0073).
  // Until now `transport.ts` looked at `res.ok` and threw the answer away.
  //
  // This is the clause ESC-08 was missing: acceptance, effective start and result are three moments, and
  // until the instrumentation could confirm the second one they were two.
  //
  // covers: ESC-08
  it("obeys a capture the cloud asked for, and sends what it saw", async () => {
    const startedRoughly = Date.now();
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const evidence: { path: string; body: unknown }[] = [];
    const batches: AggregatesBatch[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith(AGGREGATES_PATH)) {
        batches.push(JSON.parse(String(init?.body)) as AggregatesBatch);
        // Asked once: the cloud repeats an order until it sees the start, and one is enough here.
        const captures = ordered
          ? []
          : [
              {
                id: "cap-1",
                // A short window, not a zero one: with zero the capture closes inside the very flush that
                // accepted it, and its start is delivered by the evidence instead of by a batch — which is
                // fine, and not the path this test is about.
                windowSeconds: 0.05,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                method: "GET",
                route: "/products/:id",
              },
            ];
        ordered = true;
        return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
      }
      evidence.push({ path, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["pg"]) }), {
      log: quiet,
      fetchImpl,
      now: clock.now,
    });
    cleanups.push(() => agent.stop());
    agent.start();

    const request = { method: "GET", url: "/products/7" };
    channel(REQUEST_START).publish({ request });
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    // The request is behind us now, in the same clock the capture's start will come from.
    clock.here();
    // The first flush carries the batch and brings the order back.
    expect(await agent.flushNow()).toBe(true);
    // The window is 50 ms and this is what passes them.
    clock.advance(60);
    // The second reports the start and, the window having closed, hands the evidence over.
    expect(await agent.flushNow()).toBe(true);

    const reporting = batches.find((b) => b.captures !== undefined);
    expect(reporting?.captures?.[0]?.id, "the start was never reported").toBe("cap-1");
    // And the batch that reports it is one the cloud would take. The cloud validates every batch against
    // this same schema and answers 400 to what does not fit (ADR 0008), and a 400 is a batch **dropped**,
    // not retried (ADR 0035): the intervals and the profile riding with it go too. Nothing asked this
    // question of a batch the agent produces, so when gh-538 made the agent's clock a float and
    // `startedAt` stopped being the integer the contract asks for, every report of a start was refused and
    // the only sign was one line of log, said once (gh-608).
    expect(validate(reporting), ajv.errorsText(validate.errors)).toBe(true);
    expect(evidence, "no evidence was sent").toHaveLength(1);
    expect(evidence[0]?.path).toContain("/v0/captures/cap-1/evidence");

    const body = evidence[0]?.body as {
      coverage: { observedRequests: number; attachedRequests: number };
      requests: { startedAt: string }[];
      startedAt: string;
    };
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
    // The same instant by the two routes it travels: the batch (ADR 0098) and the evidence (ADR 0073).
    // They are written differently —an integer here, a date there— and they have to be the same moment, or
    // the cloud's `least(...)` is choosing between two versions of one fact (gh-608).
    expect(reporting?.captures?.[0]?.startedAt).toBe(Date.parse(body.startedAt));
    // The request happened before the order arrived, so it is **attached** detail and not observed: that is
    // the distinction CAP-01 asks for, and a total would hide it.
    expect(body.requests).toHaveLength(1);
    expect([body.coverage.observedRequests, body.coverage.attachedRequests]).toEqual([0, 1]);
    // And it is dated in the clock everyone else reads. The register measures with `performance.now()`,
    // which counts from the start of the process; sending that as an instant dates every captured request
    // to 1970 and makes every comparison between instances nonsense (gh-399).
    const dated = Date.parse(body.requests[0]?.startedAt ?? "");
    expect(Math.abs(dated - startedRoughly)).toBeLessThan(60_000);
  });

  // gh-409. The other direction of the control channel. `product.md:124` gives the instrumentation
  // «trigger on local signals»: a process whose event loop is running late knows it long before any
  // aggregate crosses the network, and by then the detail that would explain it has been overwritten.
  it("asks for a capture when a local signal stays over its threshold", async () => {
    const batches: AggregatesBatch[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith(AGGREGATES_PATH)) batches.push(JSON.parse(String(init?.body)) as AggregatesBatch);
      return new Response(JSON.stringify({ accepted: 1, inserted: 1 }), { status: 202 });
    }) as unknown as typeof fetch;

    // A runtime whose event loop is a third of a second late, interval after interval.
    const stalling = new RuntimeSampler();
    stalling.rotate = () => ({ eventLoopDelayMs: { p50: 2, p99: 330, max: 400 }, inFlightMax: 3 });
    const agent = createAgent(config("http://cloud.invalid"), { log: quiet, fetchImpl, runtime: stalling });
    cleanups.push(() => agent.stop());
    agent.start();

    // One request per flush, because an interval with no traffic carries no runtime health at all.
    for (let i = 0; i < 3; i += 1) {
      const request = { method: "GET", url: "/products" };
      channel("http.server.request.start").publish({ request });
      channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
      expect(await agent.flushNow()).toBe(true);
    }

    const asked = batches.filter((b) => b.triggers !== undefined);
    // Not on the first interval: one bad interval is what a spike looks like, and the threshold is for a
    // signal that stays (`product.md:114`).
    expect(batches[0]?.triggers).toBeUndefined();
    expect(asked, "the signal never asked for anything").not.toHaveLength(0);
    // And this batch is one the cloud would take, for the same reason as the one that reports a capture's
    // start: `observedAt` is an integer in the contract and it was being sealed from a clock with decimals,
    // so the one batch that says the process is in trouble was the one being refused and dropped (gh-608).
    expect(validate(asked[0]), ajv.errorsText(validate.errors)).toBe(true);
    const trigger = asked[0]?.triggers?.[0];
    expect(trigger?.signal).toBe("event-loop-delay");
    expect(trigger?.valueMs).toBe(330);
    // The threshold travels with the value, or the number cannot be read by anyone who does not have this
    // version of the instrumentation in front of them.
    expect(trigger?.thresholdMs).toBeGreaterThan(0);
    // And it asks once, not on every interval while the signal lasts.
    expect(asked).toHaveLength(1);
  });

  // gh-307. A capture used to arrive with the detail of what went wrong and nothing to compare it
  // against. `product.md:100`: «the instrumentation keeps, per endpoint and version, a small bounded number of
  // requests representative of the reference in use (…) Every sample identifies its reference and how it was selected».
  it("sends reference samples with a capture, and says how they were chosen", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const evidence: unknown[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith(AGGREGATES_PATH)) {
        const captures = ordered
          ? []
          : [{ id: "cap-4", windowSeconds: 0.05, expiresAt: new Date(Date.now() + 60_000).toISOString() }];
        ordered = true;
        return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
      }
      evidence.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid"), { log: quiet, fetchImpl, now: clock.now });
    cleanups.push(() => agent.stop());
    agent.start();

    // Traffic before anything is asked of the process: this is what a reference is made of.
    for (let i = 0; i < 5; i += 1) {
      const request = { method: "GET", url: `/products/${i}` };
      channel(REQUEST_START).publish({ request });
      channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    }
    expect(await agent.flushNow()).toBe(true);

    // And one while the capture is open, which must not renew the samples (REF-01).
    const during = { method: "GET", url: "/products/9" };
    channel(REQUEST_START).publish({ request: during });
    channel(RESPONSE_FINISH).publish({ request: during, response: { statusCode: 500 } });
    clock.advance(60); // the 50 ms window, closed
    expect(await agent.flushNow()).toBe(true);

    expect(evidence, "no evidence was sent").toHaveLength(1);
    const body = evidence[0] as {
      reference: {
        selection: string;
        population: number;
        renewalPaused?: boolean;
        samples: { method: string; route: string; startedAt: string; status: number }[];
      };
    };
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
    expect(body.reference.selection).toBe("uniform-reservoir");
    // Drawn from the five requests before the capture, and not from the one during it.
    expect(body.reference.population).toBe(5);
    expect(body.reference.renewalPaused).toBe(true);
    expect(body.reference.samples.length).toBeGreaterThan(0);
    for (const sample of body.reference.samples) {
      expect(sample.route).toBe("/products/:id");
      // The 500 happened during the capture: a sample of it would be the degraded behaviour walking
      // into the reference, which is what REF-01 forbids.
      expect(sample.status).toBe(200);
      // Dated in the clock everyone reads, like the captured requests (gh-399).
      expect(Math.abs(Date.parse(sample.startedAt) - Date.now())).toBeLessThan(60_000);
    }
  });

  // gh-396. The register knows, request by request, whether its detail was overwritten, and the contract
  // has a field for it on the request and not only in the totals. Nothing filled it: a request whose
  // operations were gone arrived with an empty list and no mark, which reads as one that ran nothing.
  it("says which request lost its detail, and not only how many did", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const evidence: unknown[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith(AGGREGATES_PATH)) {
        const captures = ordered
          ? []
          : [{ id: "cap-3", windowSeconds: 0.05, expiresAt: new Date(Date.now() + 60_000).toISOString() }];
        ordered = true;
        return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
      }
      evidence.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    // Two operations of room, so the second request's queries overwrite the first's.
    const fine = new FineRegister({ requests: 8, operations: 2 });
    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["pg"]) }), {
      log: quiet,
      fetchImpl,
      fine,
      now: clock.now,
    });
    cleanups.push(() => agent.stop());
    agent.start();

    for (const [n, url] of [
      [1, "/first"],
      [2, "/second"],
    ] as const) {
      const request = { method: "GET", url };
      channel(REQUEST_START).publish({ request });
      const ctx = currentContext();
      if (ctx) {
        for (let i = 0; i < 2; i += 1) {
          // Relative to the request that owns them, which is what the register stores and the contract
          // requires: an operation that started before its request would be rejected by the schema.
          recordOperationIn(ctx, {
            kind: "query",
            fingerprint: { hash: `h${n}${i}`, text: "SELECT 1" },
            startedAt: ctx.startedAt + i,
            endedAt: ctx.startedAt + i + 1,
          });
        }
      }
      channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    }
    expect(await agent.flushNow()).toBe(true);
    clock.advance(60); // the 50 ms window, closed
    expect(await agent.flushNow()).toBe(true);

    expect(evidence, "no evidence was sent").toHaveLength(1);
    const body = evidence[0] as {
      coverage: { detailLost: number; truncated: number };
      requests: { route: string; operations: unknown[]; detailLost?: boolean; truncated?: boolean }[];
    };
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
    const first = body.requests.find((r) => r.route === "/first");
    const second = body.requests.find((r) => r.route === "/second");
    // The first one's operations were overwritten: no list, and it says so instead of passing for a
    // request that ran nothing (invariant 14).
    expect(first?.operations).toEqual([]);
    expect(first?.detailLost).toBe(true);
    // The second kept its own.
    expect(second?.operations).toHaveLength(2);
    expect(second?.detailLost).toBeUndefined();
    // And the marks add up to the totals, which are counted over the same requests.
    expect(body.requests.filter((r) => r.detailLost).length).toBe(body.coverage.detailLost);
    expect(body.requests.filter((r) => r.truncated).length).toBe(body.coverage.truncated);
  });

  // gh-399. Same journey, the other half of the clock: a request that runs **while** the window is open is
  // observed, not attached. It failed for the same reason — the two numbers were compared in two clocks.
  //
  // The marker is ESC-08 and not CAP-01 on purpose: CAP-01 also asks that a requested capture compete with
  // the automatic ones for one budget, and no automatic capture exists yet (gh-307).
  //
  // covers: ESC-08
  it("counts a request made during the window as observed, and one from before as attached", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const evidence: unknown[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith(AGGREGATES_PATH)) {
        const captures = ordered
          ? []
          : [{ id: "cap-2", windowSeconds: 0.6, expiresAt: new Date(Date.now() + 60_000).toISOString() }];
        ordered = true;
        return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
      }
      evidence.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid"), { log: quiet, fetchImpl, now: clock.now });
    cleanups.push(() => agent.stop());
    agent.start();

    const before = { method: "GET", url: "/products/1" };
    channel(REQUEST_START).publish({ request: before });
    channel(RESPONSE_FINISH).publish({ request: before, response: { statusCode: 200 } });
    // The line that decides the whole test, and it is now a statement instead of a wait: everything above
    // happened before this instant and everything below after it, measured in the clock the capture's start
    // comes from. There is one, so the order is a fact and not a race (gh-538).
    clock.here();
    // This flush brings the order back and the window opens.
    expect(await agent.flushNow()).toBe(true);

    const during = { method: "GET", url: "/products/2" };
    channel(REQUEST_START).publish({ request: during });
    channel(RESPONSE_FINISH).publish({ request: during, response: { statusCode: 200 } });
    // The 600 ms window, passed without waiting for it. A loaded machine used to close it inside the flush
    // that opened it, and the test read that as the bug it is meant to catch.
    clock.advance(700);
    expect(await agent.flushNow()).toBe(true);

    expect(evidence, "no evidence was sent").toHaveLength(1);
    const body = evidence[0] as {
      startedAt?: string;
      endedAt?: string;
      coverage: { observedRequests: number; attachedRequests: number };
      // The agent sends them at the top level; `fromService` is how the cloud wraps them afterwards.
      requests?: { route?: string; startedAt?: string }[];
    };
    // A request counts as observed when its own instant is at or after the capture's start, so a mismatch
    // here is always a statement about three instants. Printing them costs nothing when the test passes and
    // is the whole diagnosis when it does not: this failed once inside `make preflight` with [0, 2], and the
    // bare difference said nothing about which of the three had moved (gh-538).
    const instants = JSON.stringify({
      captureStarted: body.startedAt,
      captureEnded: body.endedAt,
      requests: (body.requests ?? []).map((r) => ({ route: r.route, startedAt: r.startedAt })),
    });
    expect(
      [body.coverage.observedRequests, body.coverage.attachedRequests],
      `observed/attached did not match the two requests published. Instants: ${instants}`,
    ).toEqual([1, 1]);
  });

  // The rule the whole of gh-538 comes down to, and the one no sleep can check: **every instant this agent
  // produces comes from one clock**. The capture's start used to be read with `Date.now()` while the requests
  // it is compared against were dated with `performance.timeOrigin + performance.now()`; the two agree when
  // the process starts and drift apart afterwards, so inside a millisecond there was no order between them.
  //
  // Stated by putting the agent's clock an hour ahead of the wall clock. Nothing else moves, and everything
  // the agent stamps has to move with it — an instant that stays behind is an instant read somewhere else.
  //
  // covers: CAP-01
  it("takes every instant it stamps from its own clock, not from the wall clock", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const evidence: { startedAt?: string; endedAt?: string }[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith(AGGREGATES_PATH)) {
        const captures = ordered
          ? []
          : [{ id: "cap-5", windowSeconds: 0.05, expiresAt: new Date(Date.now() + 3_600_000 + 60_000).toISOString() }];
        ordered = true;
        return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
      }
      evidence.push(JSON.parse(String(init?.body)) as { startedAt?: string; endedAt?: string });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const HOUR = 3_600_000;
    let at = performance.timeOrigin + performance.now() + HOUR;
    const agent = createAgent(config("http://cloud.invalid"), { log: quiet, fetchImpl, now: () => at });
    cleanups.push(() => agent.stop());
    agent.start();

    const request = { method: "GET", url: "/products/3" };
    channel(REQUEST_START).publish({ request });
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    expect(await agent.flushNow()).toBe(true);
    at += 60; // the 50 ms window
    expect(await agent.flushNow()).toBe(true);

    expect(evidence, "no evidence was sent").toHaveLength(1);
    const started = Date.parse(String(evidence[0]?.startedAt));
    const ended = Date.parse(String(evidence[0]?.endedAt));
    const wall = Date.now();
    // Half an hour of slack: what is being told apart is an hour of offset, not a millisecond of drift, and a
    // tighter bound here would be a test about the machine's speed instead of about where the number came from.
    expect(
      started - wall,
      `the capture's start was read from the wall clock: ${evidence[0]?.startedAt}`,
    ).toBeGreaterThan(HOUR / 2);
    expect(ended - wall, `the capture's end was read from the wall clock: ${evidence[0]?.endedAt}`).toBeGreaterThan(
      HOUR / 2,
    );
    // And the end is after the start by the window the clock was advanced, which is the pair being coherent
    // rather than merely both being large.
    expect(ended).toBeGreaterThanOrEqual(started);
  });

  // The test above says «every instant it stamps» and looks at the two a capture carries. These are the ones it
  // did not look at. The interval, the profile, the coarse register and the sender each fell back to `Date.now`
  // through a default argument, and `agent.ts` passed a clock to none of them, so in production they read the
  // wall clock that ADR 0131 says no source file reads — while the guard that says so matched a call and not a
  // reference (gh-610).
  //
  // Stated the same way: the agent's clock a day ahead of the wall clock, and with a fraction, which the
  // production clock always has and the contract's instants never do.
  it("dates the interval and the profile with its own clock, in the integers the contract carries", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    const batches: AggregatesBatch[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith(AGGREGATES_PATH)) batches.push(JSON.parse(String(init?.body)) as AggregatesBatch);
      return new Response(JSON.stringify({ accepted: 1, inserted: 1 }), { status: 202 });
    }) as unknown as typeof fetch;

    const DAY = 86_400_000;
    const born = performance.timeOrigin + performance.now() + DAY + 0.4165;
    let at = born;
    // An observer on, so a request opens a context and an error reported inside it lands in the profile.
    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["http"]) }), {
      log: quiet,
      fetchImpl,
      now: () => at,
    });
    cleanups.push(() => agent.stop());
    agent.start();

    const request = { method: "GET", url: "/products/7" };
    channel(REQUEST_START).publish({ request });
    agent.report({ error: new Error("boom"), kind: "explicit" });
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    at += 1_000.25;
    // Leaving closes the profile's window, which is the only way a test shorter than a minute sees it (gh-371).
    await agent.stop();

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    // A float in either `start` is a `400`, and a `400` drops the batch whole (ADR 0035, gh-608).
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    const interval = batch?.intervals[0];
    expect(interval?.start, "the interval was dated with another clock").toBe(Math.floor(born));
    expect(interval?.durationMs).toBe(1_000);
    expect(batch?.profile, "the profile never left").toBeDefined();
    expect(batch?.profile?.start, "the profile was dated with another clock").toBe(Math.floor(born));
    expect(batch?.profile?.durationMs).toBe(1_000);
  });

  // The sender's clock is a deadline and not an instant, and it read the wall clock all the same: a wait the
  // cloud asked for was measured on a clock nothing else in the agent uses, and that a stepped wall clock moves.
  it("waits out the time the cloud asked for on its own clock", async () => {
    const REQUEST_START = "http.server.request.start";
    const RESPONSE_FINISH = "http.server.response.finish";
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      if (!String(url).endsWith(AGGREGATES_PATH)) return new Response(null, { status: 202 });
      calls += 1;
      if (calls === 1) return new Response(null, { status: 429, headers: { "retry-after": "30" } });
      return new Response(JSON.stringify({ accepted: 1, inserted: 1 }), { status: 202 });
    }) as unknown as typeof fetch;

    const clock = testClock();
    const agent = createAgent(config("http://cloud.invalid"), { log: quiet, fetchImpl, now: clock.now });
    cleanups.push(() => agent.stop());
    agent.start();

    const request = { method: "GET", url: "/products" };
    channel(REQUEST_START).publish({ request });
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    expect(await agent.flushNow()).toBe(false);
    expect(calls).toBe(1);

    clock.advance(29_000);
    expect(await agent.flushNow()).toBe(false);
    expect(calls, "asked again before the time the cloud asked for was up").toBe(1);

    clock.advance(2_000);
    expect(await agent.flushNow(), "still waiting on a clock the test did not move").toBe(true);
    expect(calls).toBe(2);
  });

  it("does not say the same start twice", async () => {
    const batches: AggregatesBatch[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith(AGGREGATES_PATH)) return new Response(null, { status: 202 });
      batches.push(JSON.parse(String(init?.body)) as AggregatesBatch);
      const captures = ordered
        ? []
        : [{ id: "cap-1", windowSeconds: 600, expiresAt: new Date(Date.now() + 600_000).toISOString() }];
      ordered = true;
      return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
    }) as unknown as typeof fetch;

    const agent = createAgent(config("http://cloud.invalid"), { log: quiet, fetchImpl });
    cleanups.push(() => agent.stop());
    agent.start();
    const request = { method: "GET", url: "/products/7" };
    for (let i = 0; i < 3; i++) {
      channel("http.server.request.start").publish({ request });
      channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
      await agent.flushNow();
    }
    const reporting = batches.filter((b) => b.captures !== undefined);
    expect(reporting).toHaveLength(1);
  });
  // `product.md:104`: «the user can exclude endpoints or whole dependencies». Excluding is not
  // observing, and what is withheld is declared so that less arriving reads as a choice (gh-361, ADR 0101).
  it("does not observe an endpoint the operator excluded, and says how many", async () => {
    const sink = await startSink();
    const app = await startApp();
    const agent = createAgent(config(sink.url, { excludeEndpoints: ["/products/:id"] }), { log: quiet });
    cleanups.push(() => agent.stop(), app.close, sink.close);
    agent.start();

    for (let i = 0; i < 5; i++) await hit(app.url, "/products");
    for (let i = 1; i <= 5; i++) await hit(app.url, `/products/${i}`);

    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0] as AggregatesBatch;
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    const [interval] = batch.intervals as [Interval];
    const routes = interval.endpoints.map((e) => e.route).sort();
    expect(routes).toEqual(["/products"]);
    // Not even in the count of requests: the whole point is that it was never looked at.
    expect(interval.endpoints.reduce((n, e) => n + e.count, 0)).toBe(5);
    // Counted, never named.
    expect(batch.agent.withholding).toEqual({ endpoints: 1 });
  });

  it("matches the normalised template and not the path it came in on", async () => {
    // Excluding `/products/1` and not `/products/:id` would be an exclusion that excludes nothing, and the
    // path is what a careless operator would write.
    const sink = await startSink();
    const app = await startApp();
    const agent = createAgent(config(sink.url, { excludeEndpoints: ["/products/1"] }), { log: quiet });
    cleanups.push(() => agent.stop(), app.close, sink.close);
    agent.start();

    await hit(app.url, "/products/1");
    expect(await agent.flushNow()).toBe(true);
    const [interval] = (sink.batches[0] as AggregatesBatch).intervals as [Interval];
    expect(interval.endpoints.map((e) => e.route)).toEqual(["/products/:id"]);
    expect((sink.batches[0] as AggregatesBatch).agent.withholding).toBeUndefined();
  });

  it("says nothing about withholding when a pattern matches nothing", async () => {
    // Zero excluded is not excluding. Declaring it would have the cloud explain an absence that is not there.
    const sink = await startSink();
    const app = await startApp();
    const agent = createAgent(config(sink.url, { excludeEndpoints: ["/nothing-like-this"] }), { log: quiet });
    cleanups.push(() => agent.stop(), app.close, sink.close);
    agent.start();

    await hit(app.url, "/products");
    expect(await agent.flushNow()).toBe(true);
    expect((sink.batches[0] as AggregatesBatch).agent.withholding).toBeUndefined();
  });
});

/**
 * Invariant 2 from the outside, for the two observers that record from a `diagnostics_channel` subscriber:
 * «An internal failure disables the instrumentation; it never breaks the application». A failure while they
 * record is one of the instrumentation's own, counted like a failure in any hook of the agent, and at the tenth
 * the instrumentation disables itself (ADR 0161, gh-663). Until then it was an uncaught exception.
 */
describe("a failure while an observer records", () => {
  /**
   * The exclusion list of the context the agent opened for the request, made to fail from inside the handler:
   * it is what every recording of both observers consults first (`context.ts:157`), and it is the agent's own.
   */
  const exploding = {
    has: (): boolean => {
      throw new Error("exclusion broke");
    },
  };
  const ioredis = tracingChannel("ioredis:command");

  /** A dependency that answers `ok`, for the application to call. */
  async function startDownstream() {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  /** One observer, and what a request of the application does against the dependency it observes. */
  type Observed = [instrument: Instrument, call: (downstream: string) => Promise<string>];
  const observed: Observed[] = [
    ["http", async (downstream) => (await fetch(downstream)).text()],
    [
      "redis",
      async () =>
        String(
          await ioredis.tracePromise(async () => "ok", {
            command: "GET",
            serverAddress: "127.0.0.1",
            serverPort: 6379,
          }),
        ),
    ],
  ];

  it.each(observed)("with %s: counted, disabled at the tenth, and every request answered", async (instrument, call) => {
    const sink = await startSink();
    const downstream = await startDownstream();
    const app = http.createServer((_req, res) => {
      const ctx = currentContext();
      if (ctx) ctx.excluded = exploding;
      call(downstream.url).then(
        (body) => res.end(body),
        (err: unknown) => res.writeHead(500).end(String(err)),
      );
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const closeApp = () => new Promise<void>((r) => app.close(() => r()));
    const fetchBefore = globalThis.fetch;
    const agent = new Agent(config(sink.url, { instrument: new Set([instrument]) }), { log: quiet });
    cleanups.push(() => agent.stop(), closeApp, downstream.close, sink.close);
    agent.start();

    const { value: answers, escaped } = await escapedFrom(async () => {
      const bodies: string[] = [];
      for (let i = 0; i < 10; i++) bodies.push(await (await fetch(appUrl)).text());
      return bodies;
    });
    expect(answers).toEqual(Array.from({ length: 10 }, () => "ok"));
    expect(escaped, "escaped as an uncaught exception").toEqual([]);
    expect(agent.stats.internalErrors).toBe(10);
    expect(agent.stats.disabled).toBe(true);
    // Disabled is off: the wrapper is gone, and the application goes on being answered.
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(await (await fetch(appUrl)).text()).toBe("ok");
  });
});
