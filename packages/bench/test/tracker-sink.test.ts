import { describe, expect, it } from "vitest";
import { TrackerSink } from "../src/tracker-sink.ts";

/**
 * The tracker sink stands in for the tracker's ingestion during the coexistence campaign (ESC-16): the DSN the
 * process under test gets points at it, the tracker's own transport sends its own envelopes, and nothing leaves
 * the machine. These tests post envelopes the way that transport does — the pinned `@sentry/node` builds
 * `<dsn path>/api/<project id>/envelope/` from the DSN it was given and answers to a 200 with a JSON body.
 */

/**
 * The URL the tracker's own transport builds from the sink's DSN. In a DSN the last path element is the
 * project id, not a URL prefix, so the envelope goes to `/api/<project id>/envelope/` (the pinned tracker's
 * `getBaseApiEndpoint`), with its authentication as a query string.
 */
function envelopeUrl(dsn: string): string {
  const u = new URL(dsn);
  const project = u.pathname.slice(1);
  return `${u.origin}/api/${project}/envelope/?sentry_version=7&sentry_key=${u.username}`;
}

/** One envelope, line by line the way the tracker serialises it: a header, then item header and payload pairs. */
function envelope(items: [Record<string, unknown>, unknown][]): string {
  const head = JSON.stringify({ sent_at: "2026-09-28T00:00:00.000Z" });
  const body = items.map(([header, payload]) => `\n${JSON.stringify(header)}\n${JSON.stringify(payload)}`).join("");
  return head + body;
}

async function post(url: string, body: string, init?: RequestInit): Promise<number> {
  const res = await fetch(url, {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return res.status;
}

describe("the tracker sink", () => {
  it("counts the envelopes and their transactions and events, and answers the way its ingestion does", async () => {
    const sink = new TrackerSink();
    const dsn = await sink.listen();
    try {
      const body = envelope([
        [{ type: "transaction" }, { transaction: "GET /products", spans: [] }],
        [{ type: "transaction" }, { transaction: "POST /checkout", spans: [] }],
        [{ type: "event" }, { exception: { values: [{ type: "Error" }] } }],
      ]);
      expect(await post(envelopeUrl(dsn), body)).toBe(200);
      expect(sink.stats).toEqual({ envelopes: 1, transactions: 2, events: 1, rejected: 0 });
    } finally {
      await sink.close();
    }
  });

  it("counts one item type at a time, across the envelopes of a round", async () => {
    const sink = new TrackerSink();
    const dsn = await sink.listen();
    try {
      const url = envelopeUrl(dsn);
      await post(url, envelope([[{ type: "event" }, { exception: { values: [{ type: "Error" }] } }]]));
      await post(url, envelope([[{ type: "transaction" }, { transaction: "GET /products" }]]));
      expect(sink.stats).toEqual({ envelopes: 2, transactions: 1, events: 1, rejected: 0 });
    } finally {
      await sink.close();
    }
  });

  it("rejects a body that is not an envelope, and counts it", async () => {
    const sink = new TrackerSink();
    const dsn = await sink.listen();
    try {
      expect(await post(envelopeUrl(dsn), "not an envelope")).toBe(400);
      expect(sink.stats).toEqual({ envelopes: 0, transactions: 0, events: 0, rejected: 1 });
    } finally {
      await sink.close();
    }
  });

  it("rejects a request that is not the envelope endpoint, and counts it", async () => {
    const sink = new TrackerSink();
    const dsn = await sink.listen();
    try {
      const u = new URL(dsn);
      expect(await post(`${u.origin}/somewhere-else`, "whatever")).toBe(404);
      expect(await fetch(`${u.origin}/1/api/1/envelope/`).then((r) => r.status)).toBe(404);
      expect(sink.stats).toEqual({ envelopes: 0, transactions: 0, events: 0, rejected: 2 });
    } finally {
      await sink.close();
    }
  });

  it("points nowhere the machine does not own: the DSN is loopback, on a port the round picked", async () => {
    const sink = new TrackerSink();
    const dsn = await sink.listen();
    try {
      expect(dsn).toMatch(/^http:\/\/publickey@127\.0\.0\.1:\d+\/1$/);
    } finally {
      await sink.close();
    }
  });
});
