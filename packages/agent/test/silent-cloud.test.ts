import { channel } from "node:diagnostics_channel";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AGGREGATES_PATH,
  type AggregatesBatch,
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

type Reply = { status: number; body?: string };
/** What the cloud does with one request: answer it, answer it when the test says so, or read it and never answer. */
type Answer = Reply | Promise<Reply> | "hold";

/** A real server on a real socket, so the sender's own `fetch` is what is being held. */
async function cloud(answer: (path: string) => Answer) {
  const seen: string[] = [];
  const answered: string[] = [];
  const batches: AggregatesBatch[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    seen.push(path);
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      // What this package sent, read back: the sender wrote it from an `AggregatesBatch`.
      if (path === AGGREGATES_PATH) batches.push(JSON.parse(body) as AggregatesBatch);
      const a = answer(path);
      // Taken and read, and the socket left open: nothing ever comes back on it.
      if (a === "hold") return;
      void Promise.resolve(a).then((r) => {
        answered.push(path);
        res.writeHead(r.status, { "content-type": "application/json" }).end(r.body ?? "");
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    /** The path of every request that reached it, in order. */
    seen,
    /** The path of every request it answered, in the order it did: what it took, as against what it was sent. */
    answered,
    /** Every batch that reached it whole, in the order they did. */
    batches,
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

/**
 * The way out, when a flush is already under way: the interval timer's, or a signal's.
 *
 * `Sender.flush` returned `false` the moment it saw a batch in flight, so the way out sent nothing of its own. The
 * last interval, the profile's window `drain()` had just closed and what the application reported last stayed in
 * the sender's queue, and the queue left with the process; nothing said so. With a cloud that answers in
 * milliseconds that is a narrow window. With a slow one it lasts as long as the batch in flight does, up to its own
 * five seconds (gh-657).
 *
 * What these assert is what the cloud has by the time `stop()` resolves, because that is what a process that calls
 * `process.exit()` right after `await shutdown()` keeps (ERR-04).
 */
describe("the way out, when a flush is already under way", () => {
  /** A request the instrumentation sees, the way `node:http` announces one. */
  const serve = (url: string): void => {
    const request = { method: "GET", url };
    channel("http.server.request.start").publish({ request });
    channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
  };
  /**
   * The routes a batch carries, out of the ones the test served. The cloud is a server in this same process, and the
   * instrumentation sees the requests it answers as well.
   */
  const routes = (b: AggregatesBatch): string[] =>
    b.intervals.flatMap((i) => i.endpoints.map((e) => e.route)).filter((r) => !r.startsWith("/v0/"));

  /** An answer the test gives when it chooses to, which is what a slow cloud is from the sender's side. */
  function later(): { reply: Promise<Reply>; give: () => void } {
    let give = (): void => {};
    const reply = new Promise<Reply>((resolve) => {
      give = () => resolve({ status: 202, body: '{"accepted":1,"inserted":1}' });
    });
    return { reply, give };
  }

  it("waits for the batch in flight and then sends its own, with everything that came after it", async () => {
    const first = later();
    let answered = 0;
    const c = await cloud(() => (answered++ === 0 ? first.reply : { status: 202 }));
    const agent = createAgent(testConfig(c.url, { intervalMs: 60_000, instrument: new Set() }), { log: quiet });
    cleanups.push(c.close, () => agent.stop());
    agent.start();
    serve("/first");
    // The interval timer's flush, with its batch in flight and the cloud taking its time over it.
    void agent.flushNow();
    serve("/last");
    agent.report({ error: new Error("reported after the first batch left"), kind: "explicit" });
    const stopping = agent.stop();
    first.give();
    await stopping;
    // Before gh-657 only the first batch was here, if that: the way out saw it in flight and sent nothing.
    expect(c.batches.map(routes)).toEqual([["/first"], ["/last"]]);
    // What was reported after the first batch left rides the way out's own, and only that one: the first batch
    // did not carry it, and its landing takes off only what it carried (gh-626).
    expect(c.batches[1]?.exceptions?.map((e) => e.kind)).toEqual(["explicit"]);
  });

  it("waits for it no longer than its own deadline, and says what it did not send", async () => {
    const c = await cloud(() => "hold");
    const debug: string[] = [];
    const agent = createAgent(testConfig(c.url, { intervalMs: 60_000, instrument: new Set() }), {
      log: { warn: () => {}, debug: (m) => debug.push(m) },
    });
    cleanups.push(c.close, () => agent.stop());
    agent.start();
    serve("/first");
    // A batch whose own timeout is far past this test's limit, so only the way out's deadline can end the wait: a
    // wait that did not keep it is red by vitest's limit, not by a clock read here.
    void agent.flushNow(600_000);
    serve("/last");
    await agent.stop();
    // The batch in flight, and nothing after it: the way out's own batch never started.
    expect(c.seen).toEqual([AGGREGATES_PATH]);
    expect(debug.join("\n")).toContain("the last batch did not land");
  }, 30_000);

  it("lets the interval's flush finish the evidence it is sending, and only then sends its own batch", async () => {
    // A capture whose window closes at once: the flush that accepts it takes it and sends its evidence, which the
    // cloud takes its time over. The way out cannot take that capture over —it is no longer under way— so the one
    // way to deliver it is to wait for the flush that is sending it.
    const orders = JSON.stringify({
      accepted: 1,
      inserted: 1,
      captures: [{ id: "cap-0", windowSeconds: 0, expiresAt: new Date(Date.now() + 600_000).toISOString() }],
    });
    const slow = later();
    let arrived = (): void => {};
    const evidenceArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let batches = 0;
    const c = await cloud((path) => {
      if (path !== AGGREGATES_PATH) {
        arrived();
        return slow.reply;
      }
      batches += 1;
      return batches === 1 ? { status: 202, body: orders } : { status: 202 };
    });
    const agent = createAgent(testConfig(c.url, { intervalMs: 60_000, instrument: new Set() }), { log: quiet });
    cleanups.push(c.close, () => agent.stop());
    agent.start();
    serve("/first");
    void agent.flushNow();
    await evidenceArrived;
    serve("/last");
    const stopping = agent.stop();
    // A cloud that answers the evidence a moment after the way out has started. What is asserted is what it had
    // taken when `stop()` resolved, not how long anything took.
    setTimeout(slow.give, 100);
    await stopping;
    expect(c.answered).toEqual([AGGREGATES_PATH, captureEvidencePath("cap-0"), AGGREGATES_PATH]);
    expect(c.batches.map(routes)).toEqual([["/first"], ["/last"]]);
  });

  it("lets a signal's flush finish, a capture's evidence included, before `shutdown()` returns", async () => {
    // `packages/agent/README.md` recommends `await shutdown()` inside the application's own `SIGTERM` handler. The
    // instrumentation's handler ran first —it was registered by `--import`, before the application existed— and
    // its flush is under way: the batch, and then the evidence of every capture under way.
    const orders = JSON.stringify({
      accepted: 1,
      inserted: 1,
      captures: [{ id: "cap-0", windowSeconds: 600, expiresAt: new Date(Date.now() + 600_000).toISOString() }],
    });
    const signalled = later();
    let batches = 0;
    const c = await cloud((path) => {
      if (path !== AGGREGATES_PATH) return { status: 202 };
      batches += 1;
      if (batches === 1) return { status: 202, body: orders };
      return signalled.reply;
    });
    const agent = createAgent(testConfig(c.url, { intervalMs: 60_000, instrument: new Set() }), {
      log: quiet,
      handleSignals: true,
    });
    // The application's own handler. With it there, the instrumentation's does not raise the signal again.
    const theApplications = (): void => {};
    process.on("SIGTERM", theApplications);
    cleanups.push(
      async () => process.removeListener("SIGTERM", theApplications),
      c.close,
      () => agent.stop(),
    );
    agent.start();
    serve("/orders");
    expect(await agent.flushNow()).toBe(true);
    const from = c.answered.length;
    process.emit("SIGTERM");
    // What the application's handler does next.
    const stopping = agent.stop();
    // A cloud that answers the signal's batch a moment after the application has started waiting. What is asserted
    // is what it had taken when `stop()` resolved, not how long anything took.
    setTimeout(signalled.give, 100);
    await stopping;
    // Before gh-657 only the evidence was here: `stop()` found the batch in flight, sent the evidence itself and
    // returned, and the batch was still waiting for its answer when the process would have left.
    expect(c.answered.slice(from)).toEqual([AGGREGATES_PATH, captureEvidencePath("cap-0")]);
  });
});

/**
 * A flush that is not leaving, while another is under way (gh-626).
 *
 * It does not wait: one per interval, each queued behind a slow cloud, would pile up. So it hands what it took to
 * the sender and the sender says it cannot send yet. What it handed over used to be wiped when the batch in flight
 * landed, because that landing emptied the exceptions and the asks whole — what it had carried and what had come
 * after alike — and nothing said so.
 */
describe("a flush that is not leaving, while another is under way", () => {
  const serve = (url: string): void => {
    const request = { method: "GET", url };
    channel("http.server.request.start").publish({ request });
    channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
  };

  it("keeps what the application reported meanwhile, and the next batch carries it", async () => {
    let give = (): void => {};
    const first = new Promise<Reply>((resolve) => {
      give = () => resolve({ status: 202, body: '{"accepted":1,"inserted":1}' });
    });
    let answered = 0;
    const c = await cloud(() => (answered++ === 0 ? first : { status: 202 }));
    const agent = createAgent(testConfig(c.url, { intervalMs: 60_000, instrument: new Set() }), { log: quiet });
    cleanups.push(c.close, () => agent.stop());
    agent.start();
    serve("/first");
    const inFlight = agent.flushNow();
    agent.report({ error: new Error("reported while the first batch was in flight"), kind: "explicit" });
    // The interval timer's next flush: it takes the report and the sender cannot send it yet.
    expect(await agent.flushNow()).toBe(false);
    give();
    expect(await inFlight).toBe(true);
    expect(await agent.flushNow()).toBe(true);
    expect(c.batches[0]?.exceptions).toBeUndefined();
    expect(c.batches[1]?.exceptions?.map((e) => [e.kind, e.count, e.total])).toEqual([["explicit", 1, 1]]);
  });
});
