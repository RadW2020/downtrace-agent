import { channel } from "node:diagnostics_channel";
import type { AddressInfo } from "node:net";
import { AGGREGATES_SCHEMA_V0 } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IntervalAggregator } from "../src/aggregator.ts";
import { enterRequest, recordOperationIn } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import type { Logger } from "../src/log.ts";
import { armMountRecording } from "../src/mounts.ts";
import { PROFILE_WINDOW_MS, ProfileAggregator } from "../src/profile.ts";
import { type RouteSource, routeOf } from "../src/routes.ts";
import { sanitizeMessage } from "../src/sanitize.ts";
import { Sender } from "../src/transport.ts";
import { SANITISER_CASES } from "./support/sanitiser-cases.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
ajv.addKeyword("x-error");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

/**
 * Invariant 5, asked of the thing that actually leaves: the serialised body.
 *
 * Every other test here asks a function. A function can be right while the value it returns is put somewhere
 * else, or copied, or logged — so the last word belongs to the bytes the sender would POST. This drives the
 * real caches, the real profile and the real sender, and greps what came out (gh-368).
 *
 * It is not a proof. A finite list of hostile inputs never is, and PostgreSQL's grammar is somebody else's:
 * what this fixes in place is that each of these **specific** ways of being wrong ends in omission.
 */
const HOSTILE: [string, string][] = [
  ["unicode dollar tag", "SELECT $étiquette$confidential_customer_name$étiquette$"],
  ["invalid dollar tag", "SELECT $a-b$ana@cliente.com$a-b$"],
  ["dollar tag after a placeholder", "SELECT $1x$ana@cliente.com$1x$"],
  ["nested comment", "SELECT /* nota /* interna */ token=sk-live-9f1c */ 1"],
  ["nested comment left open", "SELECT /* nota /* interna */ ana@cliente.com"],
  ["unterminated identifier", `SELECT * FROM "orders WHERE email = 'ana@cliente.com' AND id = 4821`],
  ["interpolated identifier", `SELECT * FROM "user ana@cliente.com 4821"`],
  ["literal", "SELECT * FROM t WHERE email = 'ana@cliente.com'"],
  ["dollar body", "SELECT $$sk-live-9f1c$$"],
];
const THROWN: [string, unknown][] = [
  ["an Error", new Error("user ana@cliente.com not found")],
  ["a thrown object", { message: "token sk-live-9f1c rejected" }],
  ["a thrown string", "id 4821 is gone"],
  // And one error for each rule of the sanitiser, each a case that rule and no other catches. The three above all
  // carry a digit or an email, so they only ever asked two of the rules (gh-651).
  ...SANITISER_CASES.map(({ message }): [string, unknown] => [message, new Error(message)]),
];
const SECRETS = [
  "confidential_customer_name",
  "ana@cliente.com",
  "sk-live-9f1c",
  "4821",
  "étiquette",
  "token=",
  ...SANITISER_CASES.map(({ value }) => value),
];

describe("what actually leaves, in the bytes", () => {
  // The mount record is armed here and not at the import of `mounts.ts`: an import must not wrap
  // `Router.prototype.use` (gh-903). The tests that register real mounts read back what this arm records.
  beforeAll(() => {
    armMountRecording(express.Router.prototype);
  });

  afterEach(() => {
    // The first test pins the system clock; the pin must not leak past it.
    vi.useRealTimers();
  });

  it("carries none of it, and is still a batch the schema accepts", async () => {
    // The system clock pinned at the 2026-09-28 failure: ten seconds below, the thirteen digits the interval
    // used to carry read 1790604821940, which holds "4821". If the real clock ever rides a swept byte again,
    // the sweep below fails (gh-829).
    vi.useFakeTimers({ now: 1_790_604_831_940, toFake: ["Date"] });
    const fingerprints = new FingerprintCache();
    const errors = new ErrorFingerprintCache();
    const profile = new ProfileAggregator({
      now: (() => {
        let t = 1_000_000;
        return () => (t += PROFILE_WINDOW_MS);
      })(),
    });

    const ctx = enterRequest();
    for (const [, sql] of HOSTILE) {
      recordOperationIn(ctx, { kind: "query", fingerprint: fingerprints.get(sql), startedAt: 0, endedAt: 1 });
    }
    for (const [, err] of THROWN) {
      recordOperationIn(ctx, { kind: "error", fingerprint: errors.get(err), startedAt: 0, endedAt: 1, failed: true });
    }
    profile.record("GET", "/orders/:id", [...(ctx.operations?.values() ?? [])]);
    const rotated = profile.rotate();
    expect(rotated, "the window should have rotated").not.toBeNull();

    let body = "";
    const sender = new Sender({
      url: "http://sink.invalid",
      token: "t",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v0" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    // A batch needs an interval: the profile rides with one, it is not a batch on its own. Its start comes from
    // the sender's clock and never from the system's, so no swept byte carries the real clock (gh-829).
    sender.enqueue({ start: 1_000_000 - 10_000, durationMs: 10_000, endpoints: [] });
    if (rotated) sender.enqueueProfile(rotated);
    expect(await sender.flush()).toBe(true);
    expect(body, "nothing was sent").not.toBe("");

    for (const secret of SECRETS) {
      expect(body, `«${secret}» reached the wire`).not.toContain(secret);
    }
    // And each of those cases did arrive, as what its rule left of it: a value missing from a batch that never
    // carried its error would prove nothing. The text of a signature is the type, the message and, after a `·`,
    // where it was thrown. Looked for as JSON writes it, since these are bytes: the `\` a URL keeps after its host is
    // `\\` in them.
    for (const { sanitised } of SANITISER_CASES) {
      const written = JSON.stringify(`Error: ${sanitised} · `).slice(1, -1);
      expect(body, `«${sanitised}» never reached the wire`).toContain(written);
    }
    expect(validate(JSON.parse(body)), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("still carries the operations, so the test above is not passing on an empty batch", async () => {
    const fingerprints = new FingerprintCache();
    const ctx = enterRequest();
    for (const [, sql] of HOSTILE) {
      recordOperationIn(ctx, { kind: "query", fingerprint: fingerprints.get(sql), startedAt: 0, endedAt: 1 });
    }
    const operations = [...(ctx.operations?.values() ?? [])];
    expect(operations.length).toBeGreaterThanOrEqual(6);
    // And the ones that were understood do carry their label: omission has to be the exception, or the
    // profile would be useless and this test would prove nothing.
    expect(operations.some((o) => o.text !== "")).toBe(true);
  });

  /**
   * A route template is made of `/` and segments, which is what the rule that takes a path out of a message takes
   * whole. It never meets one: the route is built by `src/routes.ts`, travels as the route, and no rule of
   * `src/sanitize.ts` reads it. So it arrives as written, beside the very errors whose paths did not (gh-697).
   */
  it("carries the route as it was written, beside errors whose paths it did not carry", async () => {
    const route = "/orders/:id";
    expect(sanitizeMessage(route), "a route the rules of a message would leave alone proves nothing").not.toBe(route);

    const errors = new ErrorFingerprintCache();
    const ctx = enterRequest();
    for (const { message } of SANITISER_CASES) {
      const fingerprint = errors.get(new Error(message));
      recordOperationIn(ctx, { kind: "error", fingerprint, startedAt: 0, endedAt: 1, failed: true });
    }
    let t = 1_000_000;
    const profile = new ProfileAggregator({ now: () => (t += PROFILE_WINDOW_MS) });
    profile.record("GET", route, [...(ctx.operations?.values() ?? [])]);
    const rotated = profile.rotate();
    expect(rotated, "the window should have rotated").not.toBeNull();

    let body = "";
    const sender = new Sender({
      url: "http://sink.invalid",
      token: "t",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v0" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    // The start comes from the sender's clock, not the system's (gh-829).
    sender.enqueue({ start: 1_000_000 - 10_000, durationMs: 10_000, endpoints: [] });
    if (rotated) sender.enqueueProfile(rotated);
    expect(await sender.flush()).toBe(true);

    expect(body).toContain(`"route":"${route}"`);
    // And the paths in those messages did not travel: the route came through beside a rule that works, and not for
    // want of one.
    expect(body).not.toContain("alice");
  });

  /**
   * gh-756. A request without a template — outside Express, and inside it whenever the response is given
   * before any route matched, as a middleware's 401 is — is named by the heuristic, which used to copy every
   * segment a value was not: the email, the token and the file name with a number left whole in every batch.
   * All four doors a route leaves by read the one string `routeOf` gives, so this asks the two of them that
   * ride a batch; the capture's doors are asked in the minimal test, over the same string.
   */
  it("carries none of the values of a route without a template, and the route they became", async () => {
    const urls = [
      "/users/ana@cliente.com",
      "/users/ana%40cliente.com/orders",
      "/reset-password/Zx8kQ2vN4pL9mR7tY3wB",
      "/files/report-2024-q3.pdf",
    ];
    const values = ["ana@cliente.com", "ana%40cliente.com", "Zx8kQ2vN4pL9mR7tY3wB", "report-2024-q3.pdf"];
    const routes = urls.map((url) => routeOf({ url }));

    // The aggregates door: the real interval the sender enqueues.
    const recorder = new IntervalAggregator({ now: () => 1_000_000 });
    for (let i = 0; i < routes.length; i++) recorder.record("GET", routes[i] ?? "/", 200, 1 + i);
    const interval = recorder.rotate();
    expect(interval, "the interval should have rotated").not.toBeNull();

    // The profile door: the real profile, and the operations of one request.
    const fingerprints = new FingerprintCache();
    const ctx = enterRequest();
    recordOperationIn(ctx, {
      kind: "query",
      fingerprint: fingerprints.get("SELECT id FROM orders WHERE id = ?"),
      startedAt: 0,
      endedAt: 1,
    });
    let t = 1_000_000;
    const profile = new ProfileAggregator({ now: () => (t += PROFILE_WINDOW_MS) });
    profile.record("GET", routes[0] ?? "/", [...(ctx.operations?.values() ?? [])]);
    const rotated = profile.rotate();
    expect(rotated, "the window should have rotated").not.toBeNull();

    let body = "";
    const sender = new Sender({
      url: "http://sink.invalid",
      token: "t",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v0" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    if (interval) sender.enqueue(interval);
    if (rotated) sender.enqueueProfile(rotated);
    expect(await sender.flush()).toBe(true);
    expect(body, "nothing was sent").not.toBe("");

    for (const value of values) {
      expect(body, `«${value}» reached the wire`).not.toContain(value);
    }
    // And what those values became did arrive, as the template they were folded into: omission has to be the
    // exception, or this test would prove nothing.
    for (const route of routes) {
      expect(body, `«${route}» never reached the wire`).toContain(`"route":"${route}"`);
    }
    expect(validate(JSON.parse(body)), ajv.errorsText(validate.errors)).toBe(true);
  });

  /**
   * gh-766. The other half of the same door: a middleware of a mounted router answers before any route
   * matched, and Express has trimmed `url` for it — the path the client asked for sits in `originalUrl`,
   * and so do the values. The route is read off a request a real Express (5.2.1, the package's
   * devDependency) answered, at the end of the response, the way the agent reads it.
   */
  it("carries none of the values a mounted middleware's originalUrl held, and the route they became", async () => {
    const router = express.Router();
    router.use((_req, res) => {
      res.status(401).json({});
    });
    const app = express();
    app.use("/admin", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const routes: string[] = [];
    const finish = (message: unknown): void => {
      const request = (message as { request?: unknown }).request;
      if (request !== null && typeof request === "object") routes.push(routeOf(request as RouteSource));
    };
    const ch = channel("http.server.response.finish");
    ch.subscribe(finish);
    for (const path of ["/admin/users/ana%40cliente.com/orders", "/admin/reset-password/Zx8kQ2vN4pL9mR7tY3wB"]) {
      const res = await fetch(base + path);
      await res.arrayBuffer();
    }
    ch.unsubscribe(finish);
    server.close();
    expect(routes, "the two requests were read").toEqual(["/admin/users/:id/orders", "/admin/reset-password/:id"]);

    // The aggregates door: the real interval the sender enqueues.
    const recorder = new IntervalAggregator({ now: () => 1_000_000 });
    for (const route of routes) recorder.record("GET", route, 401, 1);
    const interval = recorder.rotate();
    expect(interval, "the interval should have rotated").not.toBeNull();

    let body = "";
    const sender = new Sender({
      url: "http://sink.invalid",
      token: "t",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v0" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    if (interval) sender.enqueue(interval);
    expect(await sender.flush()).toBe(true);
    expect(body, "nothing was sent").not.toBe("");

    for (const value of ["ana%40cliente.com", "Zx8kQ2vN4pL9mR7tY3wB"]) {
      expect(body, `«${value}» reached the wire`).not.toContain(value);
    }
    // And what those values became did arrive, prefix and all: omission has to be the exception.
    for (const route of routes) {
      expect(body, `«${route}» never reached the wire`).toContain(`"route":"${route}"`);
    }
    expect(validate(JSON.parse(body)), ajv.errorsText(validate.errors)).toBe(true);
  });

  /**
   * gh-858. The mount's own value used to be the route: `app.use("/tenants/:tenant", router)` put the
   * tenant's name in every batch, and the heuristic would not have saved it, because a slug like
   * `acme-corp` is of what `segmentLooksLikeValue` leaves as written. The route is built here from a
   * request a real Express (5.2.1, the package's devDependency) answered, and driven through the real
   * interval and the real sender, and the bytes are swept for the tenant.
   */
  it("carries the mount's pattern, not the tenant it matched", async () => {
    const router = express.Router();
    router.get("/users/:id", (_req, res) => {
      res.json({});
    });
    const app = express();
    app.use("/tenants/:tenant", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The one route a request to a mounted router becomes, read the way the agent reads it: off the
    // request as it is when the response finishes.
    const routes: string[] = [];
    const finish = (message: unknown): void => {
      const request = (message as { request?: unknown }).request;
      if (request !== null && typeof request === "object") routes.push(routeOf(request as RouteSource));
    };
    const ch = channel("http.server.response.finish");
    ch.subscribe(finish);
    for (const path of ["/tenants/acme-corp/users/42", "/tenants/otro/users/7"]) {
      const res = await fetch(base + path);
      await res.arrayBuffer();
    }
    ch.unsubscribe(finish);
    server.close();
    expect(routes, "the two requests were read").toEqual(["/tenants/:tenant/users/:id", "/tenants/:tenant/users/:id"]);

    // The aggregates door: the real interval the sender enqueues.
    const recorder = new IntervalAggregator({ now: () => 1_000_000 });
    for (const route of routes) recorder.record("GET", route, 200, 1);
    const interval = recorder.rotate();
    expect(interval, "the interval should have rotated").not.toBeNull();

    let body = "";
    const sender = new Sender({
      url: "http://sink.invalid",
      token: "t",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v0" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    if (interval) sender.enqueue(interval);
    expect(await sender.flush()).toBe(true);
    expect(body, "nothing was sent").not.toBe("");

    for (const tenant of ["acme-corp", "otro"]) {
      expect(body, `«${tenant}» reached the wire`).not.toContain(tenant);
    }
    // And the pattern did arrive, twice as one route: omission has to be the exception.
    expect(body).toContain(`"route":"/tenants/:tenant/users/:id"`);
    expect(validate(JSON.parse(body)), ajv.errorsText(validate.errors)).toBe(true);
  });

  /**
   * gh-899. The same door as gh-858 with no route: a middleware under `/tenants/:tenant` answers 401 before
   * any route matched, and the route used to be the path the client asked for, tenant included. It is read
   * here off a request a real Express answered, at the end of the response, and the bytes are swept.
   */
  it("carries the pattern of the mount a middleware answered under, not the tenant it matched", async () => {
    const router = express.Router();
    router.use((_req, res) => {
      res.status(401).json({});
    });
    const app = express();
    app.use("/tenants/:tenant", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const routes: string[] = [];
    const finish = (message: unknown): void => {
      const request = (message as { request?: unknown }).request;
      if (request !== null && typeof request === "object") routes.push(routeOf(request as RouteSource));
    };
    const ch = channel("http.server.response.finish");
    ch.subscribe(finish);
    for (const path of ["/tenants/acme-corp/users/42", "/tenants/otro/users/7"]) {
      const res = await fetch(base + path);
      await res.arrayBuffer();
    }
    ch.unsubscribe(finish);
    server.close();
    expect(routes, "the two requests were read").toEqual(["/tenants/:tenant/users/:id", "/tenants/:tenant/users/:id"]);

    const recorder = new IntervalAggregator({ now: () => 1_000_000 });
    for (const route of routes) recorder.record("GET", route, 401, 1);
    const interval = recorder.rotate();
    expect(interval, "the interval should have rotated").not.toBeNull();

    let body = "";
    const sender = new Sender({
      url: "http://sink.invalid",
      token: "t",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v0" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    if (interval) sender.enqueue(interval);
    expect(await sender.flush()).toBe(true);
    expect(body, "nothing was sent").not.toBe("");

    for (const tenant of ["acme-corp", "otro"]) {
      expect(body, `«${tenant}» reached the wire`).not.toContain(tenant);
    }
    expect(body).toContain(`"route":"/tenants/:tenant/users/:id"`);
    expect(validate(JSON.parse(body)), ajv.errorsText(validate.errors)).toBe(true);
  });
});
