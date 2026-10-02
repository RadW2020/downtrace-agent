import diagnostics_channel from "node:diagnostics_channel";
import { afterEach, describe, expect, it } from "vitest";
import { CallFingerprints } from "../src/calls.ts";
import { currentContext, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { Excluded } from "../src/exclude.ts";
import { FineRegister } from "../src/fine.ts";
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
 * ERR-01, the half this ticket adds: a command the driver settles as failed is an operation with its identity,
 * not only a failed call of the dependency. The identity is the one a failed query already had (gh-338): the
 * same signature, the same bounds, beside the same counters.
 */
describe("a command that fails", () => {
  const errors = new ErrorFingerprintCache();
  const observingWithError = (): void => {
    stops.push(instrumentRedis({ ...deps, errors }));
  };

  it("records what a failed command threw, beside the failed call", async () => {
    observingWithError();
    const ctx = enterRequest();
    await command({ command: "EVAL", serverAddress: "127.0.0.1", serverPort: 6379 }, true);
    const [dep] = redisWork(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    const operations = [...(ctx.operations?.values() ?? [])];
    const error = operations.find((o) => o.kind === "error");
    expect(error, "the failure is identified, not only counted").toBeDefined();
    expect(error?.errors).toBe(1);
    expect(error?.text).toContain("redis said no");
  });

  it("records nothing extra when the command succeeds", async () => {
    observingWithError();
    const ctx = enterRequest();
    await command({ command: "GET", serverAddress: "127.0.0.1", serverPort: 6379 });
    expect(ctx.operations, "no identity is invented for a success").toBeUndefined();
  });

  it("withholds the error of a command the operator excluded, with the failed call it is beside", async () => {
    // What the operator asked not to be looked at is not looked at (`product.md:104`, ADR 0101): an excluded
    // server leaves neither its counters nor the identity of what it threw.
    observingWithError();
    const ctx = enterRequest(undefined, undefined, new Excluded(["127.0.0.1:6379"]));
    await command({ command: "EVAL", serverAddress: "127.0.0.1", serverPort: 6379 }, true);
    expect(redisWork(ctx), "an excluded dependency is not looked at at all").toEqual([]);
    expect(ctx.operations, "neither the identity of what it threw").toBeUndefined();
  });

  it("counts a fingerprint that throws as an internal error, once", async () => {
    const exploded = new Error("fingerprint broke");
    stops.push(
      instrumentRedis({
        ...deps,
        errors: {
          get: () => {
            throw exploded;
          },
        } as unknown as ErrorFingerprintCache,
      }),
    );
    const ctx = enterRequest();
    await command({ command: "EVAL", serverAddress: "127.0.0.1", serverPort: 6379 }, true);
    const [dep] = redisWork(ctx);
    // The failed call is counted; the operation the fingerprint is for is not.
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    expect(ctx.operations).toBeUndefined();
    // And the bug is the instrumentation's own, counted once (ADR 0161): the `error` handler ends the command,
    // and the `asyncEnd` that follows it finds nothing left to finish.
    expect(failures.splice(0)).toEqual([exploded]);
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

/**
 * DT-17, `product.md:142`: the detail of a request keeps its Redis commands with their timings and overlaps.
 * Each command is an operation `command` — its name and its server — beside the counter of its dependency.
 * Never its key nor its arguments: ioredis puts them on the message, and nothing here reads them (invariant 5).
 */
describe("a Redis command is an operation", () => {
  const observingCommands = (calls = new CallFingerprints("command")): void => {
    stops.push(instrumentRedis({ ...deps, commands: calls }));
  };
  const commandsOf = (ctx: RequestContext) => [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "command");

  it("records each command by its name and its server, and never its key or its arguments", async () => {
    observingCommands();
    const fine = new FineRegister();
    const ctx = enterRequest(fine, performance.now());
    await command({ command: "get", args: ["session:ana@cliente.com"], serverAddress: "127.0.0.1", serverPort: 6379 });
    await command({
      command: "hgetall",
      args: ["cart:4821"],
      serverAddress: "127.0.0.1",
      serverPort: 6379,
    });
    const operations = commandsOf(ctx);
    expect(operations.map((o) => o.text)).toEqual(["GET 127.0.0.1:6379", "HGETALL 127.0.0.1:6379"]);
    expect(operations.map((o) => o.count)).toEqual([1, 1]);
    // The sweep: nothing of the key or the arguments in any field of what was recorded.
    const recorded = JSON.stringify(operations);
    for (const secret of ["session", "ana@cliente.com", "cart", "4821"]) expect(recorded).not.toContain(secret);
    fine.request("GET", "/cart", 200, 0, 10, ctx.fineFrom, ctx.fineOps);
    expect(fine.snapshot().requests[0]?.operations.map((o) => o.kind)).toEqual(["command", "command"]);
    // And the counter is still there, as it was.
    expect(redisWork(ctx)[0]?.calls).toBe(2);
  });

  it("counts a command that failed as an execution that failed", async () => {
    observingCommands();
    const ctx = enterRequest();
    await command({ command: "eval", serverAddress: "127.0.0.1", serverPort: 6379 }, true);
    expect(commandsOf(ctx)).toMatchObject([{ text: "EVAL 127.0.0.1:6379", count: 1, errors: 1 }]);
  });

  it("records no operation when the channel does not say which command, and keeps the counter", async () => {
    observingCommands();
    const ctx = enterRequest();
    await command({ serverAddress: "127.0.0.1", serverPort: 6379 });
    expect(ctx.operations).toBeUndefined();
    expect(redisWork(ctx)[0]?.calls).toBe(1);
  });

  // The decision on the unix socket (DT-17): its place is a path, and a label with a slash in it is a 400 of the
  // whole batch. It travels with its hash alone.
  it("records a command over a unix socket with its identity and without a label", async () => {
    observingCommands();
    const ctx = enterRequest();
    await command({ command: "get", serverAddress: "/tmp/redis.sock" });
    const [operation] = commandsOf(ctx);
    expect(operation?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(operation?.text).toBe("");
  });

  it("records nothing of a server the operator excluded: neither the command nor its counter", async () => {
    observingCommands();
    const ctx = enterRequest(undefined, undefined, new Excluded(["127.0.0.1:6379"]));
    await command({ command: "get", serverAddress: "127.0.0.1", serverPort: 6379 });
    expect(redisWork(ctx)).toEqual([]);
    expect(ctx.operations).toBeUndefined();
  });

  // Invariant 2: what fails while recording the operation is the instrumentation's own, counted once, and the
  // command settles exactly as it would have.
  it("counts a register that throws as an internal error, and the command settles as it would", async () => {
    observingCommands();
    const broken = new Error("the ring broke");
    const fine = new FineRegister();
    fine.operation = () => {
      throw broken;
    };
    enterRequest(fine, performance.now());
    const { value: seen, escaped } = await escapedFrom(() =>
      channel.tracePromise(async () => "OK", { command: "get", serverAddress: "127.0.0.1", serverPort: 6379 }),
    );
    expect(seen).toBe("OK");
    expect(escaped).toEqual([]);
    expect(failures.splice(0)).toEqual([broken]);
  });
});
