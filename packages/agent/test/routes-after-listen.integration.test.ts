import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AGGREGATES_PATH, AGGREGATES_SCHEMA_V0, type AggregatesBatch, type Interval } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import express4 from "express4";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { armMounts } from "../src/mounts.ts";
import { testConfig } from "./support/agent-config.ts";
import { express4Root } from "./support/express4-root.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
ajv.addKeyword("x-error");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

/** In-process stand-in for the cloud: captures the batches it is POSTed. */
async function startSink() {
  const batches: AggregatesBatch[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === AGGREGATES_PATH) batches.push(JSON.parse(body) as AggregatesBatch);
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, batches, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function config(url: string): AgentConfig {
  return testConfig(url, { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set() });
}

function routesOf(batch: AggregatesBatch | undefined): Map<string, number> {
  const byRoute = new Map<string, number>();
  for (const interval of (batch?.intervals ?? []) as Interval[]) {
    for (const e of interval.endpoints) byRoute.set(e.route, (byRoute.get(e.route) ?? 0) + e.count);
  }
  return byRoute;
}

/** One Express to run the start-up against, and the wildcard it writes a webhook route with. */
interface Kit {
  name: string;
  make: typeof express;
  arm: () => Promise<void>;
  /** The route n8n registers its live webhooks with, in this Express's syntax. */
  webhooks: string;
}

const kits: Kit[] = [
  { name: "Express 5", make: express, arm: async () => {}, webhooks: "/webhook/*path" },
  {
    name: "Express 4",
    make: express4 as unknown as typeof express,
    webhooks: "/webhook/*",
    arm: async () => {
      const root = await express4Root();
      cleanups.push(root.close);
      armMounts(path.join(root.base, "app.js"));
    },
  },
];

/** Two files of the editor n8n serves, named by its bundler: one hash with a digit, one with none. */
const ASSETS = ["ActionPill-CwmQU5UK.js", "AgentCredentialSelect-uXdretI_.js"];

/**
 * DT-35. n8n listens before it has routes. `init()` starts the server and puts a gate in front of everything,
 * which answers «starting up» while the migrations run; when it lets requests through, nothing is registered
 * yet and Express answers a 404; seconds later `start()` registers the webhooks (`app.all("/webhook/*path")`)
 * and the editor's files (`app.use("/", express.static(…))`, a mount with no route at all). A request in that
 * window has no template to be named by, and in a webhook URL the path is what fires the workflow: whoever
 * knows it can call it (invariant 5). It was named by the heuristic, which leaves a plain word as written;
 * DT-56 decided that what Express answers with nothing matched is `(unmatched)` and no word of the path
 * travels, and from the moment the route exists, its template. The files of the editor are `(unmatched)` too.
 * Neither is ever the URL the client asked for.
 */
describe.each(kits)("a route registered after the server listens, on $name (DT-35)", (kit) => {
  it("names what arrives before the route (unmatched) and what arrives after by the template", async () => {
    await kit.arm();
    const files = await mkdtemp(path.join(os.tmpdir(), "dt35-static-"));
    cleanups.push(() => rm(files, { recursive: true, force: true }));
    await mkdir(path.join(files, "assets"));
    for (const name of ASSETS) await writeFile(path.join(files, "assets", name), "export {};\n");

    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const app = kit.make();
    let migrated = false;
    app.get("/healthz", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.use((_req, res, next) => {
      if (migrated) next();
      else res.send("n8n is starting up. Please wait");
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );
    const statuses: number[] = [];
    const ask = async (p: string) => {
      const res = await fetch(url + p);
      await res.arrayBuffer();
      statuses.push(res.status);
    };

    await ask("/webhook/nope-1"); // the gate answers it
    migrated = true;
    await ask("/webhook/nope-2"); // nothing is registered yet: Express's own 404
    app.all(kit.webhooks, (_req, res) => {
      res.status(404).json({ code: 404, message: "The requested webhook is not registered." });
    });
    app.use("/", kit.make.static(files));
    await ask("/webhook/nope-3");
    await ask("/webhook/plainsecret");
    for (const name of ASSETS) await ask(`/assets/${name}`);

    expect(statuses).toEqual([200, 404, 404, 404, 200, 200]);
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    expect(agent.stats.internalErrors, "the instrumentation stays on").toBe(0);
    expect(Object.fromEntries(routesOf(batch))).toEqual({
      // The gate's answer and the 404, and the two files of the editor: nothing of what was asked is a name.
      "(unmatched)": 4,
      [kit.webhooks]: 2,
    });
    const bytes = JSON.stringify(batch);
    for (const value of ["nope-", "plainsecret", ...ASSETS.map((a) => a.split("-")[0] ?? a)]) {
      expect(bytes, `${value} does not leave`).not.toContain(value);
    }
  });
});
