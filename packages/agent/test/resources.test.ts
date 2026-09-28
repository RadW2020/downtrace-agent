import { channel } from "node:diagnostics_channel";
import type { Interval } from "@downtrace/protocol";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { CoarseRegister } from "../src/coarse.ts";
import { recordCall } from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";
import type { Logger } from "../src/log.ts";
import { PrearmRegister } from "../src/prearm.ts";
import { ReferenceRegister } from "../src/reference.ts";
import { Sender } from "../src/transport.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * What the instrumentation says about itself. `product.md:239`: «The instrumentation measures and sends its own
 * internal resources (…) That is what is seen in the state of the project».
 *
 * The point of the numbers is one distinction: a cloud that sees nothing has to be able to tell «nothing
 * happened» from «this instrumentation has been throwing batches away for two hours» (invariant 14).
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };
const interval = (start: number): Interval => ({ start, durationMs: 10_000, endpoints: [] });

function sender(responses: Array<number | Error>, maxQueued = 6) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const next = responses.shift() ?? 202;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
  const s = new Sender({
    url: "http://cloud.test",
    token: "t",
    agent: { name: "@downtrace/agent", version: "0", runtime: "node", runtimeVersion: "24" },
    instance: { id: "i-1", hostname: "h", pid: 1 },
    deploy: { environment: "production", version: "v1" },
    log: quiet,
    fetchImpl,
    maxQueued,
    // A clock that does not move: nothing here waits on a Retry-After.
    now: () => 1_000_000,
  });
  return { s, bodies };
}

const resourcesOf = (body: string) =>
  (JSON.parse(body) as { agent: { resources?: Record<string, number | string> } }).agent.resources;

describe("the instrumentation's own resources", () => {
  it("says nothing about them until something is worth saying", () => {
    const { s, bodies } = sender([202]);
    s.enqueue(interval(1));
    return s.flush().then(() => {
      const r = resourcesOf(bodies[0] ?? "");
      // Nothing lost, nothing queued: the fields that would be zero are simply absent, and a reader who
      // sees none of them knows only that this sender has nothing to report.
      expect(r?.droppedBatches).toBeUndefined();
      expect(r?.failedBatches).toBeUndefined();
    });
  });

  it("counts the batches it threw away because the queue was full", async () => {
    // The number the whole ticket is about: telemetry that existed and is gone.
    const { s, bodies } = sender([202], 2);
    for (let i = 0; i < 5; i += 1) s.enqueue(interval(i));
    expect(await s.flush()).toBe(true);

    expect(resourcesOf(bodies[0] ?? "")?.droppedBatches).toBe(3);
  });

  it("counts what could not be sent apart from what the cloud refused", async () => {
    const { s, bodies } = sender([new Error("no route to host"), 400, 202]);
    s.enqueue(interval(1));
    await s.flush();
    s.enqueue(interval(2));
    await s.flush();
    s.enqueue(interval(3));
    expect(await s.flush()).toBe(true);

    const r = resourcesOf(bodies[2] ?? "");
    expect(r?.failedBatches).toBe(1);
    expect(r?.rejectedBatches).toBe(1);
  });

  it("starts again from zero once a batch has carried the numbers", async () => {
    const { s, bodies } = sender([202, 202], 2);
    for (let i = 0; i < 5; i += 1) s.enqueue(interval(i));
    await s.flush();
    s.enqueue(interval(9));
    expect(await s.flush()).toBe(true);

    expect(resourcesOf(bodies[0] ?? "")?.droppedBatches).toBe(3);
    // Said once. A counter that kept repeating itself would be read as loss that keeps happening.
    expect(resourcesOf(bodies[1] ?? "")?.droppedBatches).toBeUndefined();
  });

  it("keeps what a batch that never landed was going to say", async () => {
    // A counter that dies with its batch lies downwards, and downwards is the dangerous direction: it
    // makes an instrumentation that is losing data look like one that is not.
    const { s, bodies } = sender([new Error("nope"), 202], 2);
    for (let i = 0; i < 5; i += 1) s.enqueue(interval(i));
    await s.flush();
    expect(await s.flush()).toBe(true);

    const r = resourcesOf(bodies[1] ?? "");
    expect(r?.droppedBatches).toBe(3);
    expect(r?.failedBatches).toBe(1);
  });

  it("does not report a queue depth, because the useful part of it is already in the counters", async () => {
    // A batch carries everything the queue holds —the queue is capped at what one batch takes— so the
    // depth at the moment of sending is the size of the batch and says nothing. What matters is whether
    // it failed to send and whether anything was dropped, and both are here.
    const { s, bodies } = sender([new Error("nope"), 202]);
    s.enqueue(interval(1));
    await s.flush();
    s.enqueue(interval(2));
    expect(await s.flush()).toBe(true);

    const r = resourcesOf(bodies[1] ?? "");
    expect(r?.failedBatches).toBe(1);
    expect(JSON.stringify(r)).not.toContain("queued");
  });
});

/** And the half the sender cannot know about itself, which the agent fills in. */
describe("what the agent adds about itself", () => {
  it("reports the memory its registers hold and what its hooks cost", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const agent = createAgent(
      testConfig("http://cloud.invalid", {
        environment: "production",
        version: "v1",
        intervalMs: 60_000,
        instrument: new Set(),
      }),
      { log: quiet, fetchImpl },
    );
    agent.start();
    try {
      const request = { method: "GET", url: "/products" };
      channel("http.server.request.start").publish({ request });
      channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
      expect(await agent.flushNow()).toBe(true);
    } finally {
      await agent.stop();
    }

    const r = resourcesOf(bodies[0] ?? "");
    // The black box is preallocated, so this is arithmetic and not a measurement.
    expect(r?.bufferBytes).toBeGreaterThan(0);
    // Nothing has been given up, so nothing says so: absent is «did not say», and here there is nothing
    // to say (ADR 0093).
    expect(r?.shed).toBeUndefined();
    expect(r?.shedReason).toBeUndefined();
  });

  // gh-805. The reserve was the register the sum left out: `bufferBytes` added fine, coarse, reference and
  // the exclusions, and the prearmed reserve — preallocated for a route nobody has served yet — was not in
  // the number the agent says it holds. A sum that leaves a register out is the blindness gh-765 grew.
  it("counts the reserve in the memory it reports", async () => {
    const fine = new FineRegister();
    const coarse = new CoarseRegister({ now: () => 1_000_000 });
    const reference = new ReferenceRegister();
    const prearm = new PrearmRegister();
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const agent = createAgent(
      testConfig("http://cloud.invalid", {
        environment: "production",
        version: "v1",
        intervalMs: 60_000,
        instrument: new Set(["http"]),
      }),
      { log: quiet, fetchImpl, fine, coarse, reference, prearm },
    );
    agent.start();
    try {
      // Armed before the request, so the reserve holds the row and not only its preallocation.
      prearm.arm("GET /products", Date.now() - 1_000, 60_000);
      const request = { method: "GET", url: "/products" };
      channel("http.server.request.start").publish({ request });
      recordCall("postgres", "db:5432", 3, false);
      channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
      // The sum the agent reports is the sum of the registers, each by its own arithmetic.
      const expected = fine.bytes() + coarse.bytes() + reference.bytes() + prearm.bytes();
      expect(await agent.flushNow()).toBe(true);
      const r = resourcesOf(bodies[0] ?? "");
      expect(r?.bufferBytes).toBe(expected);
    } finally {
      await agent.stop();
    }
  });

  it("says in the batch what it is giving up for memory, while it lasts", async () => {
    // The loss of coverage is said the way every other loss is said (ADR 0113): the fields travel with the
    // batch, so a cloud that sees them can tell «nothing happened» from «the detail is gone and why» (COB-01).
    // A register that grew beyond its cap stands in for the one state the tripwire exists for (gh-774).
    class OverReserve extends CoarseRegister {
      override bytes(): number {
        return super.bytes() + 3 * 1024 * 1024;
      }
    }
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const agent = createAgent(
      testConfig("http://cloud.invalid", {
        environment: "production",
        version: "v1",
        intervalMs: 60_000,
        instrument: new Set(),
      }),
      { log: quiet, fetchImpl, coarse: new OverReserve({ now: () => 1_000_000 }) },
    );
    agent.start();
    try {
      const request = { method: "GET", url: "/products" };
      channel("http.server.request.start").publish({ request });
      channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
      expect(await agent.flushNow()).toBe(true);
    } finally {
      await agent.stop();
    }

    const r = resourcesOf(bodies[0] ?? "");
    expect(r?.shed).toBe("fine");
    expect(r?.shedReason).toBe("memory");
    // And the memory it says it holds is what it holds: the bloated number, not a budget.
    expect(r?.bufferBytes).toBeGreaterThan(3 * 1024 * 1024);
  });
});
