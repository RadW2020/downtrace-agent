import diagnostics_channel from "node:diagnostics_channel";
import { afterEach, describe, expect, it } from "vitest";
import { enterRequest, type RequestContext } from "../src/context.ts";
import { instrumentRedis } from "../src/instrument/redis.ts";
import type { Logger } from "../src/log.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };
const channel = diagnostics_channel.tracingChannel("ioredis:command");

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function observing(): void {
  stops.push(instrumentRedis(quiet));
}

/**
 * One command, published the way ioredis does: through the tracing channel, with the same message object at the
 * start and at the end.
 */
async function command(message: Record<string, unknown>, fail = false): Promise<void> {
  await channel
    .tracePromise(async () => {
      await new Promise((r) => setTimeout(r, 2));
      if (fail) throw new Error("redis said no");
    }, message)
    .catch(() => {});
}

const redisWork = (ctx: RequestContext) =>
  [...(ctx.work ?? new Map())].map(([, w]) => w).filter((w) => w.kind === "redis");

describe("instrumentRedis", () => {
  it("records a command against the request that issued it, under its server", async () => {
    observing();
    const ctx = enterRequest();
    await command({ command: "GET", serverAddress: "127.0.0.1", serverPort: 6379 });
    const [dep] = redisWork(ctx);
    expect(dep?.target).toBe("127.0.0.1:6379");
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(0);
    expect(dep?.ms).toBeGreaterThan(0);
  });

  it("counts a failed command as an error", async () => {
    observing();
    const ctx = enterRequest();
    await command({ command: "EVAL", serverAddress: "127.0.0.1", serverPort: 6379 }, true);
    const [dep] = redisWork(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("keeps two Redis servers apart", async () => {
    observing();
    const ctx = enterRequest();
    await command({ command: "GET", serverAddress: "cache-a", serverPort: 6379 });
    await command({ command: "GET", serverAddress: "cache-b", serverPort: 6379 });
    expect(
      redisWork(ctx)
        .map((w) => w.target)
        .sort(),
    ).toEqual(["cache-a:6379", "cache-b:6379"]);
  });

  it("falls back to no target when the driver does not say which server", async () => {
    observing();
    const ctx = enterRequest();
    await command({ command: "PING" });
    expect(redisWork(ctx)[0]?.target).toBe("");
  });

  it("ignores commands outside a request", async () => {
    observing();
    // No enterRequest: a command at startup belongs to no endpoint, and must not throw either.
    await command({ command: "INFO", serverAddress: "127.0.0.1", serverPort: 6379 });
  });

  it("stops observing when told to", async () => {
    const stop = instrumentRedis(quiet);
    stop();
    const ctx = enterRequest();
    await command({ command: "GET", serverAddress: "127.0.0.1", serverPort: 6379 });
    expect(redisWork(ctx)).toHaveLength(0);
  });
});
