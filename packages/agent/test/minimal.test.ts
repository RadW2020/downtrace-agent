import { channel } from "node:diagnostics_channel";
import { hostname } from "node:os";
import { AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import { currentContext, recordCallIn, recordOperationIn } from "../src/context.ts";
import type { Logger } from "../src/log.ts";
import { withheldName } from "../src/minimal.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
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
  return {
    token: "t",
    url: "http://sink.invalid",
    environment: "production",
    version: THEIRS.version,
    queryText: true,
    inspect: undefined,
    debug: false,
    intervalMs: 60_000,
    instrument: new Set(["pg"]),
    minimal: false,
    excludeEndpoints: [],
    excludeDependencies: [],
    ...over,
  } as AgentConfig;
}

/** Drives one request that does everything a request can do, and returns the body that would be sent. */
async function bodyOf(over: Partial<AgentConfig>): Promise<string> {
  let body = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  const agent = createAgent(config(over), { log: quiet, fetchImpl });
  agent.start();
  try {
    const request = { method: "GET", url: THEIRS.path };
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
 * `product.md:104`: «un modo mínimo en el que **ningún texto libre sale del servidor**».
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
    const sent = JSON.parse(body) as { requests: { method: string; route: string }[] };
    // The filter found it, which it could only do by comparing comparable names.
    expect(sent.requests).toHaveLength(1);
    // And the same hash as the batch, or the cloud cannot tell which endpoint this evidence is about.
    expect(sent.requests[0]?.route).toBe(withheldName(THEIRS.route));
    expect(sent.requests[0]?.method).toBe("GET");
  });

  it("leaves the finer control doing exactly what it did", async () => {
    // `DOWNTRACE_QUERY_TEXT=off` is «send my routes but not my queries», which is a real thing to want and
    // not the same as this.
    const batch = JSON.parse(await bodyOf({ queryText: false })) as AggregatesBatch;
    expect(batch.intervals[0]?.endpoints[0]?.route).toBe(THEIRS.route);
    expect(JSON.stringify(batch)).not.toContain(THEIRS.query);
  });
});
