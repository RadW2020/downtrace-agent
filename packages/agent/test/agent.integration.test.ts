import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, createAgent } from "../src/agent.ts";
import { IntervalAggregator, type Recorder } from "../src/aggregator.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

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
      if (req.method === "POST" && req.url === "/v0/aggregates" && state.status < 400)
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
    debug: false,
    intervalMs: 60_000,
    instrument: false,
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
});
