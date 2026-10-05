import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  AGGREGATES_PATH,
  AGGREGATES_SCHEMA_V0,
  type AggregatesBatch,
  CAPTURE_EVIDENCE_SCHEMA_V0,
  type Interval,
} from "@downtrace/protocol";
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
ajv.addKeyword("x-evidence-path");
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);
const validateEvidence = ajv.compile(CAPTURE_EVIDENCE_SCHEMA_V0);

/** What a request nothing named is called, and what the README says it is called. */
const UNMATCHED = "(unmatched)";

interface Evidence {
  path: string;
  body: string;
}

/**
 * In-process stand-in for the cloud: captures the batches it is POSTed and the evidence of a capture, and
 * orders the captures it is handed, once, in the answer to the next batch.
 */
async function startSink() {
  const batches: AggregatesBatch[] = [];
  const evidence: Evidence[] = [];
  const orders: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === AGGREGATES_PATH) {
        batches.push(JSON.parse(body) as AggregatesBatch);
        res
          .writeHead(202, { "content-type": "application/json" })
          .end(JSON.stringify({ accepted: 1, inserted: 1, captures: orders.splice(0) }));
        return;
      }
      if (req.method === "POST") evidence.push({ path: String(req.url), body });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, batches, evidence, orders, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function config(url: string): AgentConfig {
  return testConfig(url, { environment: "test", version: "t1", intervalMs: 60_000, instrument: new Set() });
}

/** The routes of a batch with their counts, each one as `METHOD route`: the identity the cloud keeps. */
function routesOf(batch: AggregatesBatch | undefined): Record<string, number> {
  const byRoute = new Map<string, number>();
  for (const interval of (batch?.intervals ?? []) as Interval[]) {
    for (const e of interval.endpoints) {
      const name = `${e.method} ${e.route}`;
      byRoute.set(name, (byRoute.get(name) ?? 0) + e.count);
    }
  }
  return Object.fromEntries(byRoute);
}

/** One Express to run the scenarios against, with how its routes are written and how the agent arms it. */
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

/** An application listening, an agent watching it and a sink behind the agent: what every scenario needs. */
async function serve(kit: Kit, build: (app: express.Express, make: typeof express) => void) {
  await kit.arm();
  const sink = await startSink();
  const agent = createAgent(config(sink.url), { log: quiet });
  agent.start();
  const app = kit.make();
  build(app, kit.make);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () => agent.stop(),
    () => new Promise<void>((r) => server.close(() => r())),
    sink.close,
  );
  const statuses: number[] = [];
  const ask = async (p: string, method = "GET") => {
    const res = await fetch(url + p, { method });
    await res.arrayBuffer();
    statuses.push(res.status);
  };
  /** Sends the interval, and returns the batch that came out of it, valid against the contract. */
  const flush = async () => {
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[sink.batches.length - 1];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    expect(agent.stats.internalErrors, "the instrumentation stays on").toBe(0);
    return batch;
  };
  return { app, agent, sink, ask, statuses, flush };
}

/** Every word of `words` is nowhere in `bytes`: what a leak is looked for with, in the whole of what is sent. */
function expectNoneOf(bytes: string, words: string[]): void {
  for (const word of words) expect(bytes, `«${word}» does not leave`).not.toContain(word);
}

/**
 * DT-56. A request that no route names — a 404, a file served by a mount with no route, a middleware that
 * answered at the first level, a path asked before the application registered its routes — used to be named
 * by the heuristic over the path the client asked for, and in a webhook URL the path is a secret: n8n fires
 * a workflow for whoever knows it, and a plain word is a segment no rule of shape can tell from a route's own
 * words. With Express answering, there is no template to be had, and the decision is the privacy's (invariant
 * 5): `(unmatched)`, per method, and nothing of the path travels.
 */
describe.each(kits)("a request no route names, on $name (DT-56)", (kit) => {
  /**
   * n8n's start-up as DT-35 measured it: it listens first, answers «starting up» from a middleware while it
   * migrates, lets Express answer a 404, and registers `/webhook/*path` seconds later.
   */
  function n8nLike() {
    let migrated = false;
    return {
      open: () => {
        migrated = true;
      },
      build: (app: express.Express) => {
        app.get("/healthz", (_req, res) => {
          res.json({ status: "ok" });
        });
        app.use((_req, res, next) => {
          if (migrated) next();
          else res.send("n8n is starting up. Please wait");
        });
      },
    };
  }

  it("travels as (unmatched) per method, and its word is in no byte of the batch", async () => {
    const n8n = n8nLike();
    const { app, ask, statuses, flush } = await serve(kit, (a) => n8n.build(a));

    await ask("/webhook/gated-word"); // the gate answers it: a middleware of the first level
    n8n.open();
    await ask("/webhook/plainsecret", "POST"); // nothing is registered yet: Express's own 404
    await ask("/webhook/nope-9");
    for (const scanner of ["/.env", "/wp-login.php", "/zzcanary-3f2a1b"]) await ask(scanner);
    app.all(kit.webhooks, (_req, res) => {
      res.status(404).json({ code: 404, message: "The requested webhook is not registered." });
    });
    await ask("/webhook/plainsecret", "POST");
    await ask("/healthz");

    expect(statuses).toEqual([200, 404, 404, 404, 404, 404, 404, 200]);
    const batch = await flush();
    expect(routesOf(batch)).toEqual({
      [`GET ${UNMATCHED}`]: 5,
      [`POST ${UNMATCHED}`]: 1,
      [`POST ${kit.webhooks}`]: 1,
      "GET /healthz": 1,
    });
    expectNoneOf(JSON.stringify(batch), ["plainsecret", "gated-word", "nope-9", ".env", "wp-login", "zzcanary"]);
  });

  it("is named the same in the black box as in the aggregate, and a capture of it finds the requests", async () => {
    const n8n = n8nLike();
    n8n.open();
    const { app, ask, sink, flush } = await serve(kit, (a) => n8n.build(a));
    app.get("/known", (_req, res) => {
      res.json({});
    });

    await ask("/webhook/plainsecret", "POST");
    await ask("/known");
    // The cloud knows the route by the name the batch gave it, and orders a capture of it by that name.
    sink.orders.push({
      id: "cap-unmatched",
      windowSeconds: 0.05,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      method: "POST",
      route: UNMATCHED,
    });
    const first = await flush();
    await ask("/webhook/plainsecret-too", "POST");
    await new Promise((r) => setTimeout(r, 100));
    await flush();

    expect(routesOf(first)).toEqual({ [`POST ${UNMATCHED}`]: 1, "GET /known": 1 });
    expect(sink.evidence, "no evidence was sent").toHaveLength(1);
    const evidence = sink.evidence[0];
    expect(evidence?.path).toContain("/v0/captures/cap-unmatched/evidence");
    const body = JSON.parse(evidence?.body ?? "{}") as {
      requests: { method: string; route: string }[];
      coarse?: { routes: { method: string; route: string }[] };
    };
    expect(validateEvidence(body), ajv.errorsText(validateEvidence.errors)).toBe(true);
    // The requests the capture was asked for were found, which they can only be when both halves of the
    // black box carry the name the aggregate does.
    expect(body.requests.map((r) => `${r.method} ${r.route}`)).toEqual([`POST ${UNMATCHED}`, `POST ${UNMATCHED}`]);
    // (The sink is a server of this very process, and the agent watches it too: its own requests are in the
    // minutes as well, so this asks for what is there and not for all of it.)
    const coarse = (body.coarse?.routes ?? []).map((r) => `${r.method} ${r.route}`);
    expect(coarse).toEqual(expect.arrayContaining(["GET /known", `POST ${UNMATCHED}`]));
    expectNoneOf(evidence?.body ?? "", ["plainsecret"]);
  });

  it("names a file served by a mount with no pattern, and a file that is not there, (unmatched)", async () => {
    const files = await mkdtemp(path.join(os.tmpdir(), "dt56-static-"));
    cleanups.push(() => rm(files, { recursive: true, force: true }));
    await mkdir(path.join(files, "assets"));
    // The names a bundler gives its files: one with a digit and a long mixed-case run, and a plain word, which
    // is the one the heuristic would have let through as written.
    for (const name of ["assets/ActionPill-CwmQU5UK.js", "family-secrets.txt"])
      await writeFile(path.join(files, name), "x");

    const { ask, statuses, flush } = await serve(kit, (app, make) => {
      app.use("/", make.static(files));
    });
    await ask("/assets/ActionPill-CwmQU5UK.js");
    await ask("/family-secrets.txt");
    await ask("/not-there.txt");

    expect(statuses).toEqual([200, 200, 404]);
    const batch = await flush();
    expect(routesOf(batch)).toEqual({ [`GET ${UNMATCHED}`]: 3 });
    expectNoneOf(JSON.stringify(batch), ["ActionPill", "CwmQU5UK", "family-secrets", "not-there"]);
  });

  it("names a middleware that answers at the first level, with no mount at all, (unmatched)", async () => {
    const { ask, statuses, flush } = await serve(kit, (app) => {
      app.use((req, res, next) => {
        if (req.path.startsWith("/proxy/")) res.status(502).end("bad gateway");
        else next();
      });
    });
    await ask("/proxy/internal-billing-service");
    expect(statuses).toEqual([502]);
    const batch = await flush();
    expect(routesOf(batch)).toEqual({ [`GET ${UNMATCHED}`]: 1 });
    expectNoneOf(JSON.stringify(batch), ["internal-billing"]);
  });

  it("goes on naming a registered route as it did, mounted or not", async () => {
    const { ask, flush } = await serve(kit, (app, make) => {
      app.get("/products/:id", (_req, res) => {
        res.json({});
      });
      const tenants = make.Router();
      tenants.get("/users/:id", (_req, res) => {
        res.json({});
      });
      app.use("/tenants/:tenant", tenants);
    });
    await ask("/products/42");
    await ask("/products/plain-word");
    await ask("/tenants/acme-corp/users/7");
    const batch = await flush();
    expect(routesOf(batch)).toEqual({
      "GET /products/:id": 2,
      "GET /tenants/:tenant/users/:id": 1,
    });
    expectNoneOf(JSON.stringify(batch), ["plain-word", "acme-corp"]);
  });
});

/**
 * DT-26, closed by DT-56. A middleware under a mount with a parameter that rejects with `next(err)`, whose
 * error the app's handler answers, reached the end of the response with `baseUrl` already put back to nothing,
 * and its route came from the path the client asked for: the tenant's name travelled in it. The route no
 * longer comes from there. A request nothing named is `(unmatched)`, and the price is that the mount's name
 * is not on it.
 */
describe.each(kits)("a middleware under a mount with a parameter, on $name (DT-26)", (kit) => {
  const PATHS = ["/tenants/acme-corp/users/42", "/tenants/globex/users/7"];
  const TENANTS = ["acme-corp", "globex"];

  /** The handler of the app, which is what answers the error a middleware hands on. */
  const answerErrors = (app: express.Express) => {
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(401).json({ error: "unauthorized" });
    });
  };

  it("hands the error on from the app's mount, and the app answers: (unmatched), with no tenant in the batch", async () => {
    const { ask, statuses, flush } = await serve(kit, (app) => {
      app.use("/tenants/:tenant", (_req, _res, next) => {
        next(new Error("denied"));
      });
      answerErrors(app);
    });
    for (const p of PATHS) await ask(p);
    expect(statuses).toEqual([401, 401]);
    const batch = await flush();
    expect(routesOf(batch)).toEqual({ [`GET ${UNMATCHED}`]: 2 });
    expectNoneOf(JSON.stringify(batch), TENANTS);
  });

  it("hands the error on from a router mounted there, and the app answers: (unmatched), with no tenant in the batch", async () => {
    const { ask, statuses, flush } = await serve(kit, (app, make) => {
      const router = make.Router();
      router.use((_req, _res, next) => {
        next(new Error("denied"));
      });
      app.use("/tenants/:tenant", router);
      answerErrors(app);
    });
    for (const p of PATHS) await ask(p);
    expect(statuses).toEqual([401, 401]);
    const batch = await flush();
    expect(routesOf(batch)).toEqual({ [`GET ${UNMATCHED}`]: 2 });
    expectNoneOf(JSON.stringify(batch), TENANTS);
  });

  it("answers from the router itself, and the mount is still on baseUrl: it keeps the pattern, with no tenant in the batch", async () => {
    // The case gh-899 closed, beside the two that it did not reach: the mount is read from the routers the
    // request went through while `baseUrl` still holds it, and that is not a request nothing named.
    const { ask, statuses, flush } = await serve(kit, (app, make) => {
      const router = make.Router();
      router.use((_req, res) => {
        res.status(401).json({});
      });
      app.use("/tenants/:tenant", router);
    });
    for (const p of PATHS) await ask(p);
    expect(statuses).toEqual([401, 401]);
    const batch = await flush();
    expect(routesOf(batch)).toEqual({ "GET /tenants/:tenant/users/:id": 2 });
    expectNoneOf(JSON.stringify(batch), TENANTS);
  });
});

/**
 * DT-56. With no framework to ask — a server on `node:http` alone — there are no routes registered to have
 * named the request, and the heuristic is the reserve, as it was. Nothing changes.
 */
describe("a server with no framework (DT-56)", () => {
  it("names its requests by the heuristic, as it did", async () => {
    const sink = await startSink();
    const agent = createAgent(config(sink.url), { log: quiet });
    agent.start();
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end("nope");
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(
      () => agent.stop(),
      () => new Promise<void>((r) => server.close(() => r())),
      sink.close,
    );

    for (const p of ["/webhook/nope-9", "/users/42", "/users/ana@cliente.com", "/healthz"]) {
      const res = await fetch(url + p);
      await res.arrayBuffer();
    }
    expect(await agent.flushNow()).toBe(true);
    const batch = sink.batches[0];
    expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
    expect(routesOf(batch)).toEqual({
      "GET /webhook/:id": 1,
      "GET /users/:id": 2,
      "GET /healthz": 1,
    });
  });
});
