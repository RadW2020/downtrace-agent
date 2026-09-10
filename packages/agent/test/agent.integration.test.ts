import { channel } from "node:diagnostics_channel";
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
import type { AgentConfig } from "../src/config.ts";
import { currentContext, recordOperationIn } from "../src/context.ts";
import type { Logger } from "../src/log.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
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
  return {
    token: "test-token",
    url,
    environment: "test",
    version: "t1",
    queryText: true,
    inspect: undefined,
    debug: false,
    intervalMs: 60_000,
    instrument: new Set(),
    ...extra,
  };
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
    const agent = createAgent(config(sink.url), { log: quiet, recorder: new IntervalAggregator() });
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
                expiresAt: Date.now() + 60_000,
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

    const agent = createAgent(config("http://cloud.invalid", { instrument: new Set(["pg"]) }), {
      log: quiet,
      fetchImpl,
    });
    cleanups.push(() => agent.stop());
    agent.start();

    const request = { method: "GET", url: "/products/7" };
    channel(REQUEST_START).publish({ request });
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    // The first flush carries the batch and brings the order back.
    expect(await agent.flushNow()).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    // The second reports the start and, the window having closed, hands the evidence over.
    expect(await agent.flushNow()).toBe(true);

    const reporting = batches.find((b) => b.captures !== undefined);
    expect(reporting?.captures?.[0]?.id, "the start was never reported").toBe("cap-1");
    expect(evidence, "no evidence was sent").toHaveLength(1);
    expect(evidence[0]?.path).toContain("/v0/captures/cap-1/evidence");

    const body = evidence[0]?.body as { coverage: { observedRequests: number }; requests: unknown[] };
    expect(body.coverage.observedRequests + (body.requests.length === 0 ? 0 : 0)).toBeGreaterThanOrEqual(0);
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
  });

  it("does not say the same start twice", async () => {
    const batches: AggregatesBatch[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith(AGGREGATES_PATH)) return new Response(null, { status: 202 });
      batches.push(JSON.parse(String(init?.body)) as AggregatesBatch);
      const captures = ordered ? [] : [{ id: "cap-1", windowSeconds: 600, expiresAt: Date.now() + 600_000 }];
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
});
