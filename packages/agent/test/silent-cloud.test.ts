import { channel } from "node:diagnostics_channel";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AGGREGATES_PATH,
  type CaptureEvidence,
  captureEvidencePath,
  type Interval,
  PROTOCOL_VERSION,
} from "@downtrace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { MAX_LIVE_CAPTURES } from "../src/captures.ts";
import type { Logger } from "../src/log.ts";
import { Sender } from "../src/transport.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * Invariant 4, the half no sink in this package exercised: a cloud that takes the connection and never answers.
 *
 * Every other sink here answers —`202`, `500`, `401`, `429`— or refuses the connection, and a timeout acts in
 * neither case. So deleting the one on the batch or the one on the evidence left every test green, and a flush
 * that never settles holds `inflight` for ever: the sender stops sending and does not count it (gh-650).
 *
 * What these assert is what reached the cloud, never how long it took (ADR 0114). A hang is red all the same, by
 * vitest's own limit.
 */

/** What the cloud does with one request: answer it, or read it and never answer. */
type Answer = { status: number; body?: string } | "hold";

/** A real server on a real socket, so the sender's own `fetch` is what is being held. */
async function cloud(answer: (path: string) => Answer) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      const a = answer(req.url ?? "");
      // Taken and read, and the socket left open: nothing ever comes back on it.
      if (a === "hold") return;
      res.writeHead(a.status, { "content-type": "application/json" }).end(a.body ?? "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    /** The path of every request that reached it, in order. */
    seen,
    close: () =>
      new Promise<void>((r) => {
        // The held responses would keep `close` waiting for ever, which is the very thing under test.
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const quiet: Logger = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const interval = (start: number): Interval => ({ start, durationMs: 10_000, endpoints: [] });

/** A sender with the real `fetch`: the one a user's process has. */
function sender(url: string, timeoutMs?: number): Sender {
  return new Sender({
    url,
    token: "tok",
    agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
    instance: { id: "i", hostname: "h", pid: 1 },
    deploy: { version: "v", environment: "test" },
    log: quiet,
    timeoutMs,
    now: () => 1_000_000,
  });
}

/** An evidence the contract accepts, with nothing in it: what is under test is the request, not its body. */
const evidence: CaptureEvidence = {
  protocol: PROTOCOL_VERSION,
  instance: { id: "i" },
  startedAt: "2026-09-24T00:00:00.000Z",
  endedAt: "2026-09-24T00:00:10.000Z",
  coverage: { observedRequests: 0, attachedRequests: 0, detailLost: 0, truncated: 0 },
  requests: [],
};

describe("the sender, against a cloud that takes the connection and never answers", () => {
  it("gives up on the batch at its timeout, keeps it, and reaches the cloud again on the next flush", async () => {
    const c = await cloud(() => "hold");
    cleanups.push(c.close);
    const s = sender(c.url, 250);
    s.enqueue(interval(1));
    expect(await s.flush()).toBe(false);
    expect(await s.flush()).toBe(false);
    // Twice: a flush that never let go of `inflight` would have made the second return without sending.
    expect(c.seen).toEqual([AGGREGATES_PATH, AGGREGATES_PATH]);
    expect(s.failed).toBe(2);
    expect(s.pending, "a batch nobody answered is not a batch the cloud refused").toBe(1);
  });

  it("gives up on a capture's evidence at its timeout", async () => {
    const c = await cloud(() => "hold");
    cleanups.push(c.close);
    expect(await sender(c.url).sendEvidence("cap-1", evidence, 250)).toBe(false);
    expect(c.seen).toEqual([captureEvidencePath("cap-1")]);
  });

  it("holds the batch and the evidence to one deadline when it is handed one", async () => {
    const c = await cloud(() => "hold");
    cleanups.push(c.close);
    const s = sender(c.url);
    s.enqueue(interval(1));
    const deadline = AbortSignal.timeout(250);
    expect(await s.flush(deadline)).toBe(false);
    expect(await s.sendEvidence("cap-1", evidence, deadline)).toBe(false);
    expect(c.seen, "the evidence started a clock of its own").toEqual([AGGREGATES_PATH]);
  });
});

/**
 * The way out: `stop()`, and so `shutdown()`, `beforeExit` and a signal, which all go through the same flush.
 *
 * `SHUTDOWN_FLUSH_MS` bounded the batch and nothing after it. Each capture under way then sent its evidence with
 * the sender's default of five seconds, one after another, so against a cloud that had stopped answering `stop()`
 * took 6, 11 and 21 seconds with one, two and four captures — and a process whose only `SIGTERM` listener is
 * ours waited all of it before the signal was raised again (gh-650).
 *
 * The limit on the two tests that hold is long on purpose. Without one deadline they take twenty seconds and then
 * fail on what reached the cloud, which says more than a timeout does.
 */
describe("the way out, against a cloud that stops answering", () => {
  const orders = JSON.stringify({
    accepted: 1,
    inserted: 1,
    captures: Array.from({ length: MAX_LIVE_CAPTURES }, (_, i) => ({
      id: `cap-${i}`,
      // Long enough that no window closes on its own: every one is still under way when the process leaves.
      windowSeconds: 600,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
  });
  const every = Array.from({ length: MAX_LIVE_CAPTURES }, (_, i) => captureEvidencePath(`cap-${i}`));

  /**
   * An agent watching as many captures as it can at once. The cloud asks for them in its answer to the first
   * batch and, from then on, does whatever the test says. What reaches it after that is what `stop()` sent.
   */
  async function watching(then: (path: string) => Answer) {
    let asked = false;
    const c = await cloud((path) => {
      if (asked) return then(path);
      asked = true;
      return { status: 202, body: orders };
    });
    const debug: string[] = [];
    const agent = createAgent(testConfig(c.url, { intervalMs: 60_000, instrument: new Set() }), {
      log: { warn: () => {}, debug: (m) => debug.push(m) },
    });
    cleanups.push(c.close, () => agent.stop());
    agent.start();
    const request = { method: "GET", url: "/orders" };
    channel("http.server.request.start").publish({ request });
    channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
    expect(await agent.flushNow()).toBe(true);
    const from = c.seen.length;
    return { agent, debug, sentOnTheWayOut: () => c.seen.slice(from) };
  }

  it("gives all of it one deadline, and starts no evidence once it has passed", async () => {
    const { agent, debug, sentOnTheWayOut } = await watching(() => "hold");
    await agent.stop();
    // The batch, held until the deadline; and then nothing, because nothing started after it could land.
    expect(sentOnTheWayOut()).toEqual([AGGREGATES_PATH]);
    // And it says so, because there is no next batch to count it in: the batch that did not land, and the
    // captures the cloud will see expire.
    expect(debug.join("\n")).toContain("the last batch did not land");
    expect(debug.join("\n")).toContain(`${MAX_LIVE_CAPTURES} capture(s) left without their evidence`);
  }, 30_000);

  it("cuts the evidence in flight at the same deadline, and starts none after it", async () => {
    const { agent, sentOnTheWayOut } = await watching((path) => (path === AGGREGATES_PATH ? { status: 202 } : "hold"));
    await agent.stop();
    expect(sentOnTheWayOut()).toEqual([AGGREGATES_PATH, every[0]]);
  }, 30_000);

  it("still hands over every capture's evidence when the cloud answers", async () => {
    // Partial evidence is an answer and silence is not (ESC-08): the deadline is a limit, not a reason to skip.
    const { agent, sentOnTheWayOut } = await watching(() => ({ status: 202 }));
    await agent.stop();
    expect(sentOnTheWayOut()).toEqual([AGGREGATES_PATH, ...every]);
  });
});
