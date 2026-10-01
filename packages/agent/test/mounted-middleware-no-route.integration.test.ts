import http from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * One Express to run the scenarios against: the version's own factory, and how the record of mounts is armed
 * the way `Agent.start()` arms it in production (before the application registers anything).
 */
interface Kit {
  name: string;
  make: typeof express;
  arm: () => Promise<void>;
  /** A mount path whose last part takes any number of segments, written the way this Express reads it. */
  wildcard: string;
  /**
   * What a middleware answering under `app.use(["/a/:x", "/b/literal"], mw)` becomes for a request to the
   * second path: Express 5 keeps a matcher per path and says which matched, Express 4 keeps one regexp for all.
   */
  arrayRoute: string;
}

const kits: Kit[] = [
  { name: "Express 5", make: express, arm: async () => {}, wildcard: "/orgs/*rest", arrayRoute: "/b/literal/u/:id" },
  {
    name: "Express 4",
    wildcard: "/orgs/*",
    arrayRoute: "/:param/:param/u/:id",
    make: express4 as unknown as typeof express,
    arm: async () => {
      const root = await express4Root();
      cleanups.push(root.close);
      armMounts(path.join(root.base, "app.js"));
    },
  },
];

/** The application under test, answering the paths it is given, and the batch the agent sent about them. */
async function run(kit: Kit, build: (app: express.Express, make: typeof express) => void, paths: string[]) {
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
  for (const p of paths) {
    const res = await fetch(url + p);
    await res.arrayBuffer();
    statuses.push(res.status);
  }
  expect(await agent.flushNow()).toBe(true);
  const batch = sink.batches[0];
  expect(validate(batch), ajv.errorsText(validate.errors)).toBe(true);
  expect(agent.stats.internalErrors, "the instrumentation stays on").toBe(0);
  return { statuses, routes: routesOf(batch), bytes: JSON.stringify(batch) };
}

/**
 * gh-899. A middleware that answers before any route matched leaves the request with no `req.route`, and its
 * route came from `originalUrl` as the client wrote it: under a mount with a parameter, the tenant's name
 * went to the cloud inside the route (invariant 5). With the mount still on `baseUrl` at the end of the
 * response, the mount comes out as the pattern it was registered with, and what is left of the path goes
 * through the heuristic.
 */
describe.each(kits)("a middleware that answers under a mount keeps the mount's pattern on $name (gh-899)", (kit) => {
  it("names the mount of a router's middleware by its pattern, not by the tenant", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const router = make.Router();
        router.use((_req, res) => {
          res.status(401).json({});
        });
        app.use("/tenants/:tenant", router);
      },
      ["/tenants/acme-corp/users/42", "/tenants/otro/users/7"],
    );
    expect(out.statuses).toEqual([401, 401]);
    expect([...out.routes]).toEqual([["/tenants/:tenant/users/:id", 2]]);
    expect(out.bytes, "the tenant's name does not leave").not.toContain("acme-corp");
  });

  it("names the mount of a function mounted with a parameter by its pattern", async () => {
    const out = await run(
      kit,
      (app) => {
        app.use("/tenants/:tenant", (_req, res) => {
          res.status(401).json({});
        });
      },
      ["/tenants/acme-corp/users/42"],
    );
    expect([...out.routes]).toEqual([["/tenants/:tenant/users/:id", 1]]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("names both the app and the router mounts of a middleware inside a sub-app", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const sub = make();
        sub.use((_req, res) => {
          res.status(403).json({});
        });
        app.use("/orgs/:org", sub);
      },
      ["/orgs/acme-corp/members/7"],
    );
    expect(out.statuses).toEqual([403]);
    expect([...out.routes]).toEqual([["/orgs/:org/members/:id", 1]]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("says :param per segment for an app mounted with a wildcard, whose pattern has no count of segments", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const sub = make();
        sub.use((_req, res) => {
          res.status(403).json({});
        });
        app.use(kit.wildcard, sub);
      },
      ["/orgs/acme-corp/team/red/members/7"],
    );
    expect(out.statuses).toEqual([403]);
    // The wildcard took the whole path, so the whole path is the mount: every segment of it a parameter.
    expect([...out.routes].map(([route]) => route)).toEqual(["/:param/:param/:param/:param/:param/:param"]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("names a mount registered with a regular expression as :param per segment, never as its value", async () => {
    const out = await run(
      kit,
      (app) => {
        app.use(/^\/t\/[a-z0-9-]+/, (_req, res) => {
          res.status(401).json({});
        });
      },
      ["/t/acme-corp/users/42"],
    );
    expect([...out.routes].map(([route]) => route)).toEqual(["/:param/:param/users/:id"]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("does not guess between two mounts that match the same stretch with different patterns", async () => {
    const out = await run(
      kit,
      (app) => {
        app.use("/tenants/:tenant", (_req, _res, next) => {
          next();
        });
        app.use("/tenants/acme-corp", (_req, res) => {
          res.status(401).json({});
        });
      },
      ["/tenants/acme-corp/users/42"],
    );
    expect(out.statuses).toEqual([401]);
    expect([...out.routes], "a stretch that cannot be told is a parameter, not either pattern").toEqual([
      ["/:param/:param/users/:id", 1],
    ]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("keeps a literal mount that is registered twice with the same pattern", async () => {
    const out = await run(
      kit,
      (app) => {
        app.use("/admin", (_req, _res, next) => {
          next();
        });
        app.use("/admin", (_req, res) => {
          res.status(401).json({});
        });
      },
      ["/admin/users/42"],
    );
    expect([...out.routes]).toEqual([["/admin/users/:id", 1]]);
  });

  it("keeps a literal mount when the other mount of its stretch is a middleware that took less", async () => {
    const out = await run(
      kit,
      (app) => {
        app.use("/api", (_req, _res, next) => {
          next();
        });
        app.use("/api/v1", (_req, res) => {
          res.status(401).json({});
        });
      },
      ["/api/v1/users/42"],
    );
    expect([...out.routes]).toEqual([["/api/v1/users/:id", 1]]);
  });

  it("does not guess between a router and a mount that matched stretches of different lengths", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const carrier = make.Router();
        carrier.use("/v1", (_req, _res, next) => {
          next();
        });
        app.use("/api", carrier);
        app.use("/api/v1", (_req, res) => {
          res.status(401).json({});
        });
      },
      ["/api/v1/users/42"],
    );
    expect(out.statuses).toEqual([401]);
    expect([...out.routes]).toEqual([["/:param/:param/users/:id", 1]]);
  });

  it("does not guess between two routers on the same stretch that explain the rest differently", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const first = make.Router();
        first.use("/tenants/:tenant", (_req, _res, next) => {
          next();
        });
        const second = make.Router();
        second.use("/tenants/acme-corp", (_req, res) => {
          res.status(401).json({});
        });
        app.use("/api", first);
        app.use("/api", second);
      },
      ["/api/tenants/acme-corp/users/42"],
    );
    expect(out.statuses).toEqual([401]);
    expect([...out.routes]).toEqual([["/api/:param/:param/users/:id", 1]]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("names the mounts inside a sub-app after the app's own, each by its pattern", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const sub = make();
        sub.use("/teams/:team", (_req, res) => {
          res.status(403).json({});
        });
        app.use("/orgs/:org", sub);
      },
      ["/orgs/acme-corp/teams/red/members/7"],
    );
    expect(out.statuses).toEqual([403]);
    expect([...out.routes]).toEqual([["/orgs/:org/teams/:team/members/:id", 1]]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("goes on through the router a mount carries, naming each mount by its pattern", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const api = make.Router();
        api.use("/tenants/:tenant", (_req, res) => {
          res.status(401).json({});
        });
        app.use("/api", api);
      },
      ["/api/tenants/acme-corp/users/42"],
    );
    expect([...out.routes]).toEqual([["/api/tenants/:tenant/users/:id", 1]]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("looks through a router mounted with no path, which takes nothing of baseUrl and carries the mounts", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const api = make.Router();
        api.use("/admin", (_req, res) => {
          res.status(401).json({});
        });
        api.use("/tenants/:tenant", (_req, res) => {
          res.status(401).json({});
        });
        app.use(api);
      },
      ["/admin/users/42", "/tenants/acme-corp/users/7"],
    );
    expect([...out.routes].sort()).toEqual([
      ["/admin/users/:id", 1],
      ["/tenants/:tenant/users/:id", 1],
    ]);
    expect(out.bytes).not.toContain("acme-corp");
  });

  it("follows the router that carries the rest when two routers share the prefix", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const users = make.Router();
        users.get("/list", (_req, res) => {
          res.json({});
        });
        const orders = make.Router();
        orders.use("/admin", (_req, res) => {
          res.status(403).json({});
        });
        app.use("/api", users);
        app.use("/api", orders);
      },
      ["/api/admin/reports/42"],
    );
    expect(out.statuses).toEqual([403]);
    expect([...out.routes]).toEqual([["/api/admin/reports/:id", 1]]);
  });

  it("keeps the literal of a mount nested in a prefix that another mount shares", async () => {
    const out = await run(
      kit,
      (app, make) => {
        app.use("/api", make.Router());
        const admin = make.Router();
        admin.use((_req, res) => {
          res.status(403).json({});
        });
        app.use("/api/admin", admin);
      },
      ["/api/admin/reports/42"],
    );
    expect(out.statuses).toEqual([403]);
    expect([...out.routes]).toEqual([["/api/admin/reports/:id", 1]]);
  });

  it("does not take the first path of a mount registered with several for the one that matched", async () => {
    const out = await run(
      kit,
      (app) => {
        app.use(["/a/:x", "/b/literal"], (_req, res) => {
          res.status(401).json({});
        });
      },
      ["/b/literal/u/1"],
    );
    expect([...out.routes]).toEqual([[kit.arrayRoute, 1]]);
  });

  it("does not believe the apps above when an app mounted under a router leaves the chain short", async () => {
    const out = await run(
      kit,
      (app, make) => {
        const router = make.Router();
        const outer = make();
        const inner = make();
        inner.use((_req, res) => {
          res.status(403).json({});
        });
        outer.use("/b/:y", inner);
        router.use("/a/:x", outer);
        app.use("/api", router);
      },
      ["/api/a/acme-corp/b/globex/z/1"],
    );
    expect(out.statuses).toEqual([403]);
    expect([...out.routes]).toEqual([["/:param/:param/:param/:param/:param/z/:id", 1]]);
    expect(out.bytes).not.toContain("acme-corp");
    expect(out.bytes).not.toContain("globex");
  });

  it("keeps what gh-766 decided: a literal mount stays a word, and a 404 of finalhandler is unchanged", async () => {
    const out = await run(
      kit,
      (app) => {
        app.use("/static", (_req, res) => {
          res.status(200).end("css");
        });
      },
      ["/static/app.css", "/nothing/here"],
    );
    expect(out.statuses).toEqual([200, 404]);
    expect([...out.routes].map(([route]) => route).sort()).toEqual(["/nothing/here", "/static/app.css"]);
  });
});
