import diagnostics_channel from "node:diagnostics_channel";
import { afterEach, describe, expect, it } from "vitest";
import { currentContext, enterRequest, type RequestContext } from "../src/context.ts";
import { instrumentRedis } from "../src/instrument/redis.ts";
import type { Logger } from "../src/log.ts";
import { escapedFrom } from "./support/escaped.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };
const channel = diagnostics_channel.tracingChannel("ioredis:command");

/**
 * What the observer reported as a failure of its own. Until gh-663 such a failure was an uncaught exception,
 * which the runner reports; now it is handed over here, and a test that is not about one checks it stays empty,
 * so it is as loud as it was.
 */
const failures: unknown[] = [];
const deps = {
  log: quiet,
  internalError: (err: unknown): void => {
    failures.push(err);
  },
};

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  expect(failures.splice(0), "the observer failed while recording").toEqual([]);
});

function observing(): void {
  stops.push(instrumentRedis(deps));
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
    const stop = instrumentRedis(deps);
    stop();
    const ctx = enterRequest();
    await command({ command: "GET", serverAddress: "127.0.0.1", serverPort: 6379 });
    expect(redisWork(ctx)).toHaveLength(0);
  });
});

/**
 * Invariant 2 on both ways a command ends, and `product.md:241`: «it never throws exceptions into the user's code
 * nor breaks the application». Until gh-663 the handlers recorded with no guard, and Node rethrows a subscriber's
 * throw on the next tick as an uncaught exception, which ends the process. The channel is Node's own, published
 * the way ioredis does: what Node does with a subscriber's throw is the whole claim, and it is Node's code.
 */
describe("a failure while recording never reaches the application", () => {
  const broken = new Error("exclusion broke");
  /**
   * The request's exclusion list, which `recordCallIn` consults before anything else (`context.ts:157`): the
   * instrumentation's own code, not the driver's.
   */
  const exploding = {
    has: (): boolean => {
      throw broken;
    },
  };
  const refused = new Error("redis said no");

  /** What the command settled with. Compared by identity: the value and the error are the application's own. */
  async function settled(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
    try {
      return { value: await run() };
    } catch (error) {
      return { error };
    }
  }

  type Command = [name: string, run: () => Promise<unknown>];
  const commands: Command[] = [
    [
      "a command that succeeds",
      () => channel.tracePromise(async () => "OK", { command: "GET", serverAddress: "127.0.0.1", serverPort: 6379 }),
    ],
    [
      "a command that fails",
      () =>
        channel.tracePromise(
          async () => {
            throw refused;
          },
          { command: "EVAL", serverAddress: "127.0.0.1", serverPort: 6379 },
        ),
    ],
  ];

  it.each(commands)("%s settles as it does outside a request, and the failure is counted", async (_command, run) => {
    observing();
    // The same command where the observer records nothing, which is what the application sees without it.
    expect(currentContext(), "the first command has to run outside a request").toBeUndefined();
    const bare = await settled(run);
    enterRequest(undefined, undefined, exploding);
    const { value: seen, escaped } = await escapedFrom(() => settled(run));
    expect(seen.value).toBe(bare.value);
    expect(seen.error).toBe(bare.error);
    expect(escaped, "escaped as an uncaught exception").toEqual([]);
    // Handed to the agent's count of internal errors once, by whichever handler ended the command.
    expect(failures.splice(0)).toEqual([broken]);
  });
});
