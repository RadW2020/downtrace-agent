import { channel } from "node:diagnostics_channel";
import { hostname } from "node:os";
import { AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import { currentContext, recordCallIn, recordOperationIn } from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";
import type { Logger } from "../src/log.ts";
import { withheldName } from "../src/minimal.ts";
import { PrearmRegister } from "../src/prearm.ts";
import { testConfig } from "./support/agent-config.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

const REQUEST_START = "http.server.request.start";
const RESPONSE_FINISH = "http.server.response.finish";

/** Everything about this application that the operator wrote, and none of which may leave. */
const THEIRS = {
  route: "/orders/:id",
  path: "/orders/1234",
  target: "orders-db.internal:5432",
  query: "SELECT id FROM orders WHERE id = ?",
  version: "v2.4.1-acme",
  message: "the acme checkout is down",
};

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return testConfig("http://sink.invalid", {
    environment: "production",
    version: THEIRS.version,
    intervalMs: 60_000,
    instrument: new Set(["pg"]),
    ...over,
  });
}

/** Drives one request that does everything a request can do, and returns the body that would be sent. */
async function bodyOf(over: Partial<AgentConfig> = {}, path: string = THEIRS.path): Promise<string> {
  let body = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  const agent = createAgent(config(over), { log: quiet, fetchImpl });
  agent.start();
  try {
    const request = { method: "GET", url: path };
    channel(REQUEST_START).publish({ request });
    const ctx = currentContext();
    if (ctx) {
      recordCallIn(ctx, "postgres", THEIRS.target, 3);
      recordOperationIn(ctx, {
        kind: "query",
        fingerprint: { hash: "abc123", text: THEIRS.query },
        startedAt: 0,
        endedAt: 1,
      });
    }
    channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
    // Leaving closes the profile's window, which is the only way a short-lived test sees it (gh-371).
    await agent.stop();
  } finally {
    // `stop` is idempotent; this is only here so a throw above does not leave the agent subscribed.
    await agent.stop();
  }
  return body;
}

/**
 * `product.md:104`: «a minimal mode in which no free text leaves the server».
 *
 * What counts as free text was decided by inventory rather than by memory — every string a real batch
 * carries, sorted into what the operator wrote and what is ours — and this asks the question of the bytes
 * that would actually be sent, which is the only place worth asking it (gh-390, ADR 0105).
 */
describe("the minimal mode", () => {
  it("sends none of what the operator wrote", async () => {
    const body = await bodyOf({ minimal: true });
    expect(body, "nothing was sent").not.toBe("");
    for (const [what, value] of Object.entries(THEIRS)) {
      expect(body, `«${what}» reached the wire`).not.toContain(value);
    }
    // And the hostname, which is theirs too and is not in the table above because it is the machine's.
    expect(body).not.toContain(hostname());
  });

  it("is still a batch the protocol accepts", async () => {
    const body = await bodyOf({ minimal: true });
    expect(validate(JSON.parse(body)), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("keeps what is ours, or there is no contract left", async () => {
    const batch = JSON.parse(await bodyOf({ minimal: true })) as AggregatesBatch;
    expect(batch.protocol).toBeTruthy();
    expect(batch.agent.name).toBe("@downtrace/agent");
    // The method is not the operator's, and losing it would cost a reader the little that is left.
    expect(batch.intervals[0]?.endpoints[0]?.method).toBe("GET");
    expect(batch.intervals[0]?.endpoints[0]?.dependencies?.[0]?.kind).toBe("postgres");
    // The environment stays: the ingest token already tells the cloud which one this is, so withholding
    // it protects nothing and would collapse the scope the product is organised by (ADR 0105).
    expect(batch.deploy.environment).toBe("production");
  });

  it("says so, in the field the cloud reads", async () => {
    const batch = JSON.parse(await bodyOf({ minimal: true })) as AggregatesBatch;
    expect(batch.agent.withholding).toMatchObject({ freeText: true });
  });

  it("gives the same name the same identity every time", async () => {
    // Without this the cloud cannot group anything, and the mode would cost the whole analysis.
    const first = JSON.parse(await bodyOf({ minimal: true })) as AggregatesBatch;
    const second = JSON.parse(await bodyOf({ minimal: true })) as AggregatesBatch;
    const route = first.intervals[0]?.endpoints[0]?.route;
    expect(route).toBe(second.intervals[0]?.endpoints[0]?.route);
    expect(route).toBe(withheldName(THEIRS.route));
    // And it is marked as withheld, which is what the cloud recognises (ADR 0104).
    expect(route?.startsWith("#")).toBe(true);
  });

  it("digests the collapsed route, so a value of the path no longer enters the digest", async () => {
    // A request without a template carries its value in the url, and the heuristic is what reads it. The
    // digest is of what the heuristic leaves (ADR 0104, ADR 0105), so what it now folds stops entering it,
    // and the same request is the same digest in every batch, which is what the analysis groups by.
    const first = JSON.parse(await bodyOf({ minimal: true }, "/users/ana@cliente.com")) as AggregatesBatch;
    const second = JSON.parse(await bodyOf({ minimal: true }, "/users/ana@cliente.com")) as AggregatesBatch;
    const route = first.intervals[0]?.endpoints[0]?.route;
    expect(route).toBe(second.intervals[0]?.endpoints[0]?.route);
    // The digest of the route it became, not of the value it carried: a digest of the value could be
    // confirmed by whoever guesses it, because the code that computes it is public and has no key.
    expect(route).toBe(withheldName("/users/:id"));
    expect(route).not.toBe(withheldName("/users/ana@cliente.com"));
    expect(route?.startsWith("#")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("ana@cliente.com");
  });

  it("changes nothing when it is off", async () => {
    const batch = JSON.parse(await bodyOf({})) as AggregatesBatch;
    expect(batch.intervals[0]?.endpoints[0]?.route).toBe(THEIRS.route);
    expect(batch.deploy.version).toBe(THEIRS.version);
    expect(batch.agent.withholding).toBeUndefined();
  });

  // gh-395. The batch was the easy half. A capture freezes the black box and sends it down a path of its
  // own, and that path copied the route straight out of the register. The ADR 0105 left the hole named:
  // «el modo mínimo tiene un agujero del tamaño de una captura».
  //
  // covers: ESC-08
  it("withholds the route in a capture's evidence too, and still finds the requests it was asked for", async () => {
    const evidence: { path: string; body: string }[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/v0/aggregates")) {
        // The cloud only ever knew the withheld name, so that is what its order carries. Before this, the
        // filter compared it against the real route and every capture in minimal mode came back empty.
        const captures = ordered
          ? []
          : [
              {
                id: "cap-1",
                windowSeconds: 0.05,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                method: "GET",
                route: withheldName(THEIRS.route),
              },
            ];
        ordered = true;
        return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
      }
      evidence.push({ path, body: String(init.body) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const agent = createAgent(config({ minimal: true }), { log: quiet, fetchImpl });
    agent.start();
    try {
      const request = { method: "GET", url: THEIRS.path };
      channel(REQUEST_START).publish({ request });
      channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
      await new Promise((r) => setTimeout(r, 20));
      expect(await agent.flushNow()).toBe(true);
      await new Promise((r) => setTimeout(r, 80));
      expect(await agent.flushNow()).toBe(true);
    } finally {
      await agent.stop();
    }

    expect(evidence, "no evidence was sent").toHaveLength(1);
    const body = evidence[0]?.body ?? "";
    // Asked of the bytes that would be sent, like everything else here.
    for (const [what, value] of Object.entries(THEIRS)) {
      expect(body, `«${what}» reached the wire in a capture`).not.toContain(value);
    }
    const sent = JSON.parse(body) as {
      requests: { method: string; route: string }[];
      reference: { samples: { route: string }[] };
      coarse?: { routes: { method: string; route: string }[] };
    };
    // The samples carry routes too, and they are the operator's words like any other (gh-307).
    expect(sent.reference.samples.length, "no samples, so the loop below checks nothing").toBeGreaterThan(0);
    for (const sample of sent.reference.samples) {
      expect(sample.route).toBe(withheldName(THEIRS.route));
    }
    // The filter found it, which it could only do by comparing comparable names.
    expect(sent.requests).toHaveLength(1);
    // And the same hash as the batch, or the cloud cannot tell which endpoint this evidence is about.
    expect(sent.requests[0]?.route).toBe(withheldName(THEIRS.route));
    expect(sent.requests[0]?.method).toBe("GET");
    // The coarse minutes are named by the same nameOf the fine requests are, so the minute a route was doing
    // belongs to the endpoint the capture was asked for — withheld, never the template the operator wrote.
    expect(sent.coarse?.routes.length, "the coarse summary carried no route").toBeGreaterThan(0);
    expect(sent.coarse?.routes[0]?.route).toBe(withheldName(THEIRS.route));
    expect(sent.coarse?.routes[0]?.route).toBe(sent.requests[0]?.route);
  });

  // gh-860, the mirror of gh-498 in minimal mode. gh-395 made the capture find the ring's rows by the
  // withheld name, but the reserve's rows were stored under a name the cloud does not know, and each of the
  // three places where the two meet — the reserve's key, the matcher, the evidence — encrypted again a name
  // that had already left encrypted. A capture of an armed route in minimal mode came out with only what the
  // global ring happened to keep.
  it("finds the reserve of an armed route by the withheld name, and it leaves encrypted once", async () => {
    const prearm = new PrearmRegister();
    // A ring so small that a few requests of other routes evict the armed one: whatever the evidence still
    // shows of this route can only be what the reserve kept (ADR 0122).
    const fine = new FineRegister({
      requests: 4,
      operations: 64,
      operationsPerRequest: 8,
      routeLabels: 16,
      fingerprintLabels: 16,
      dependencyLabels: 16,
    });
    const evidence: { path: string; body: string }[] = [];
    let ordered = false;
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/v0/aggregates")) {
        // The cloud only ever knew the withheld name, so its order carries it.
        const captures = ordered
          ? []
          : [
              {
                id: "cap-1",
                windowSeconds: 0.05,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                method: "GET",
                route: withheldName(THEIRS.route),
              },
            ];
        ordered = true;
        return new Response(JSON.stringify({ accepted: 1, inserted: 1, captures }), { status: 202 });
      }
      evidence.push({ path, body: String(init.body) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const agent = createAgent(config({ minimal: true, instrument: new Set(["http"]) }), {
      log: quiet,
      fetchImpl,
      fine,
      prearm,
    });
    // The arm is keyed by the name the cloud knows: that is all the signal that arms it can see.
    prearm.arm(`GET ${withheldName(THEIRS.route)}`, Date.now() - 1_000, 60_000);
    agent.start();
    try {
      const request = { method: "GET", url: THEIRS.path };
      channel(REQUEST_START).publish({ request });
      const ctx = currentContext();
      if (ctx) {
        recordOperationIn(ctx, {
          kind: "query",
          fingerprint: { hash: "abc123", text: THEIRS.query },
          startedAt: 0,
          endedAt: 1,
        });
      }
      channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
      // Traffic that evicts the armed row from the shared ring.
      for (const url of ["/other/a", "/other/b", "/other/c", "/other/d"]) {
        const other = { method: "GET", url };
        channel(REQUEST_START).publish({ request: other });
        channel(RESPONSE_FINISH).publish({ request: other, response: { statusCode: 200 } });
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(await agent.flushNow()).toBe(true);
      await new Promise((r) => setTimeout(r, 80));
      expect(await agent.flushNow()).toBe(true);
    } finally {
      await agent.stop();
    }

    expect(evidence, "no evidence was sent").toHaveLength(1);
    const body = evidence[0]?.body ?? "";
    // The real template never reaches the bytes, in the capture as in the batch.
    expect(body, `«${THEIRS.route}» reached the wire in a capture`).not.toContain(THEIRS.route);
    const sent = JSON.parse(body) as {
      requests: { method: string; route: string }[];
      coverage: { observedRequests: number; attachedRequests: number };
    };
    // The armed request is in the evidence and the ring no longer holds it: it is the reserve's.
    expect(sent.requests, "the capture of the armed route came out empty").toHaveLength(1);
    // Encrypted once: the outside name the cloud knows, and not the digest of a digest.
    expect(sent.requests[0]?.route).toBe(withheldName(THEIRS.route));
    expect(sent.requests[0]?.route).not.toBe(withheldName(withheldName(THEIRS.route)));
    // And it is one that ran before the capture began, which is what the reserve exists for.
    expect(sent.coverage.attachedRequests).toBeGreaterThanOrEqual(1);
  });

  it("leaves the finer control doing exactly what it did", async () => {
    // `DOWNTRACE_QUERY_TEXT=off` is «send my routes but not my queries», which is a real thing to want and
    // not the same as this.
    const batch = JSON.parse(await bodyOf({ queryText: false })) as AggregatesBatch;
    expect(batch.intervals[0]?.endpoints[0]?.route).toBe(THEIRS.route);
    expect(JSON.stringify(batch)).not.toContain(THEIRS.query);
  });
});
