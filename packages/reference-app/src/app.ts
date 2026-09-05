import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import express from "express";
import { Cache } from "./cache.ts";
import { checkout } from "./checkout.ts";
import { type AppConfig, configFromEnv } from "./config.ts";
import { Db } from "./db.ts";
import { BadRequestError, ColdStartError, HttpError, InventoryMismatchError, NotFoundError } from "./errors.ts";
import { FakeProvider } from "./provider.ts";
import { ProviderClient } from "./provider-client.ts";
import { Regressions } from "./regressions.ts";
import { countError, newCounters, Stats } from "./stats.ts";

export type ReferenceAppOptions = Partial<AppConfig>;

export interface ReferenceApp {
  app: express.Express;
  config: AppConfig;
  stats: Stats;
  regressions: Regressions;
  provider: FakeProvider;
  db: Db;
  cache: Cache;
  /** Migrates, seeds, connects and listens. Returns the bound ports (useful with port 0). */
  start(): Promise<{ port: number; providerPort: number }>;
  stop(): Promise<void>;
}

export function createReferenceApp(overrides: ReferenceAppOptions = {}): ReferenceApp {
  const config: AppConfig = { ...configFromEnv(), ...overrides };
  const regressions = Regressions.fromEnv(config.regressions);
  const stats = new Stats();
  const db = new Db({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    connectionTimeoutMillis: config.pgConnectionTimeoutMs,
  });
  const cache = new Cache(config.redisUrl);
  const provider = new FakeProvider((manual) =>
    regressions.isEnabled("slow_dependency") ? regressions.params("slow_dependency").delayMs : manual,
  );
  const providerClient = new ProviderClient(() => provider.url, regressions);

  const app = express();
  app.disable("x-powered-by");

  // Ground truth per request, recorded when the response finishes. Admin traffic is not product traffic.
  app.use((req, res, next) => {
    if (req.path.startsWith("/__admin")) return next();
    const start = performance.now();
    const ctx = newCounters();
    res.locals.ctx = ctx;
    res.on("finish", () => {
      const route = (req.route as { path?: string } | undefined)?.path;
      const key = `${req.method} ${route ? req.baseUrl + route : "(unmatched)"}`;
      stats.record(key, res.statusCode, performance.now() - start, ctx);
    });
    next();
  });

  // Simulated cold start: the first STARTUP_FAILURE_MS of product traffic get a 503, like a database still warming up.
  let firstRequestAt: number | undefined;
  app.use((req, _res, next) => {
    if (config.startupFailureMs <= 0 || req.path.startsWith("/__admin")) return next();
    firstRequestAt ??= performance.now();
    if (performance.now() - firstRequestAt < config.startupFailureMs) return next(new ColdStartError());
    next();
  });
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", version: config.appVersion });
  });

  app.get("/products", async (_req, res) => {
    const { rows } = await db.query(res.locals.ctx, "SELECT id, name, price_cents, stock FROM products ORDER BY id");
    res.json(rows);
  });

  app.get("/products/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new BadRequestError("product id must be an integer");
    const { rows } = await db.query(res.locals.ctx, "SELECT id, name, price_cents, stock FROM products WHERE id = $1", [
      id,
    ]);
    if (!rows[0]) throw new NotFoundError(`product ${id} not found`);
    if (regressions.isEnabled("new_error") && Math.random() < regressions.params("new_error").rate) {
      throw new InventoryMismatchError(id);
    }
    res.json(rows[0]);
  });

  app.get("/me", async (req, res) => {
    const userId = Number(req.header("x-user-id") ?? "1");
    if (!Number.isInteger(userId)) throw new BadRequestError("x-user-id must be an integer");
    const key = `session:${userId}`;
    const cached = await cache.get(res.locals.ctx, key);
    if (cached !== null) {
      res.json(JSON.parse(cached));
      return;
    }
    const { rows } = await db.query(res.locals.ctx, "SELECT id, email, name FROM users WHERE id = $1", [userId]);
    if (!rows[0]) throw new NotFoundError(`user ${userId} not found`);
    await cache.set(res.locals.ctx, key, JSON.stringify(rows[0]), 300);
    res.json(rows[0]);
  });

  app.post("/checkout", async (req, res) => {
    const result = await checkout({ db, cache, provider: providerClient, regressions }, res.locals.ctx, req.body);
    res.status(201).json(result);
  });

  if (config.adminEnabled) {
    const admin = express.Router();
    admin.get("/regressions", (_req, res) => {
      res.json(regressions.snapshot());
    });
    admin.put("/regressions", (req, res) => {
      res.json(regressions.update(req.body));
    });
    admin.get("/provider", (_req, res) => {
      res.json(provider.control);
    });
    admin.put("/provider", (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const key of ["delayMs", "failureRate"] as const) {
        if (key in body) {
          const v = body[key];
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
            throw new BadRequestError(`${key} must be a non-negative number`);
          if (key === "failureRate" && v > 1) throw new BadRequestError("failureRate must be within [0, 1]");
          provider.control[key] = v;
        }
      }
      res.json(provider.control);
    });
    admin.get("/stats", (_req, res) => {
      res.json(stats.snapshot());
    });
    // Resource usage of this process, sampled by the overhead benchmark.
    admin.get("/process", (_req, res) => {
      res.json({
        pid: process.pid,
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
        eventLoopUtilization: performance.eventLoopUtilization(),
        uptimeMs: Math.round(process.uptime() * 1000),
      });
    });
    admin.post("/stats/reset", (_req, res) => {
      stats.reset();
      res.status(204).end();
    });
    app.use("/__admin", admin);
  }

  app.use((_req, _res, next) => {
    next(new NotFoundError("route not found"));
  });

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const name = err instanceof Error ? err.name : "UnknownError";
    countError(res.locals.ctx, name);
    const status = err instanceof HttpError ? err.status : (statusOf(err) ?? 500);
    const message = err instanceof HttpError || status < 500 ? (err as Error).message : "internal error";
    if (status >= 500) {
      // One line per 5xx on stderr so whoever runs the app (the bench harness, a developer) sees why it failed.
      const detail = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      console.error(
        JSON.stringify({ level: "error", status, method: req.method, path: req.path, error: name, message: detail }),
      );
    }
    res.status(status).json({ error: name, message });
  });

  let server: Server | undefined;
  return {
    app,
    config,
    stats,
    regressions,
    provider,
    db,
    cache,
    async start() {
      await db.migrate();
      await cache.connect();
      const providerPort = await provider.listen(config.providerPort);
      const port = await new Promise<number>((resolve, reject) => {
        const listening = app.listen(config.port, "127.0.0.1");
        server = listening;
        listening.once("error", reject);
        listening.once("listening", () => resolve((listening.address() as AddressInfo).port));
      });
      return { port, providerPort };
    },
    async stop() {
      const running = server;
      if (running) {
        running.closeAllConnections();
        await new Promise<void>((resolve) => running.close(() => resolve()));
      }
      await provider.close();
      await cache.close();
      await db.close();
    },
  };
}

/** body-parser and friends attach a numeric `status` to their errors. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" && s >= 400 && s < 600 ? s : undefined;
}
