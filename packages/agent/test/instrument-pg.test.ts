import { describe, expect, it } from "vitest";
import { enterRequest } from "../src/context.ts";
import { instrumentPg } from "../src/instrument/pg.ts";
import type { Logger } from "../src/log.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };

/** What the current request recorded against Postgres. */
function pgWork(ctx: { work: Map<string, { calls: number; ms: number; errors: number }> | undefined }) {
  return ctx.work?.get("postgres") ?? { calls: 0, ms: 0, errors: 0 };
}

/** A stand-in for `pg` whose `query` covers the shapes the real driver accepts. */
function fakePg(): {
  module: { Client: { prototype: Record<string, unknown> }; Pool: { prototype: Record<string, unknown> } };
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  class Client {
    query(...args: unknown[]): unknown {
      calls.push(args);
      const last = args.at(-1);
      if (typeof last === "function") {
        const cb = last as (err: unknown, res: unknown) => void;
        setTimeout(() => cb(null, { rows: [] }), 1);
        return undefined;
      }
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text;
      if (text === "boom") return Promise.reject(new Error("query failed"));
      if (text === "cursor") return { read: () => {} }; // not thenable: passes through unmeasured
      return Promise.resolve({ rows: [{ ok: 1 }] });
    }
  }
  /** A pool that takes `waitMs` to hand over a client, the way a busy one does. */
  class Pool {
    waitMs = 25;
    connect(): Promise<unknown> {
      return new Promise((resolve) => setTimeout(() => resolve(new Client()), this.waitMs));
    }
  }
  return {
    module: {
      Client: Client as unknown as { prototype: Record<string, unknown> },
      Pool: Pool as unknown as { prototype: Record<string, unknown> },
    },
    calls,
  };
}

function instrumented() {
  const pg = fakePg();
  const version = instrumentPg({ log: quiet, moduleImpl: pg.module });
  const client = new (pg.module.Client as unknown as new () => { query: (...a: unknown[]) => unknown })();
  return { ...pg, version, client };
}

describe("instrumentPg", () => {
  it("counts a promise query against the request that issued it", async () => {
    const { client } = instrumented();
    const ctx = enterRequest();
    await client.query("select 1");
    await client.query({ text: "select $1", values: [1] });
    expect(pgWork(ctx).calls).toBe(2);
    expect(pgWork(ctx).ms).toBeGreaterThanOrEqual(0);
  });

  it("counts the callback form, and the application still gets its callback", async () => {
    const { client } = instrumented();
    const ctx = enterRequest();
    const res = await new Promise((resolve) => client.query("select 1", (_e: unknown, r: unknown) => resolve(r)));
    expect(res).toEqual({ rows: [] });
    expect(pgWork(ctx).calls).toBe(1);
  });

  it("a failing query reaches the application unchanged, and still counts", async () => {
    const { client } = instrumented();
    const ctx = enterRequest();
    await expect(client.query("boom")).rejects.toThrow("query failed");
    expect(pgWork(ctx).calls).toBe(1);
    expect(pgWork(ctx).errors).toBe(1); // a failed call is counted as an error against the dependency
  });

  it("passes the arguments through untouched", async () => {
    const { client, calls } = instrumented();
    enterRequest();
    await client.query({ text: "select $1::int", values: [7] });
    expect(calls[0]).toEqual([{ text: "select $1::int", values: [7] }]);
  });

  it("does not count work outside a request", async () => {
    const { client } = instrumented();
    const result = await client.query("select 1"); // a startup query, no request context
    expect(result).toEqual({ rows: [{ ok: 1 }] });
  });

  it("leaves a non-thenable result (a cursor) alone", () => {
    const { client } = instrumented();
    const ctx = enterRequest();
    expect(client.query("cursor")).toEqual({ read: expect.any(Function) });
    expect(pgWork(ctx).calls).toBe(1); // counted at call time; its duration is not observable here
  });

  it("instruments once, however many times it is called", () => {
    const pg = fakePg();
    const first = pg.module.Client.prototype.query;
    instrumentPg({ log: quiet, moduleImpl: pg.module });
    const wrapped = pg.module.Client.prototype.query;
    instrumentPg({ log: quiet, moduleImpl: pg.module });
    expect(pg.module.Client.prototype.query).toBe(wrapped);
    expect(wrapped).not.toBe(first);
  });

  it("does nothing when there is no pg to instrument", () => {
    expect(instrumentPg({ log: quiet, moduleImpl: {} })).toBeUndefined();
    expect(instrumentPg({ log: quiet, moduleImpl: { Client: { prototype: {} } } })).toBeUndefined();
    expect(instrumentPg({ log: quiet, moduleImpl: { Client: { prototype: { query: 42 } } } })).toBeUndefined();
  });
});

describe("waiting for a connection", () => {
  it("counts the time a request waited for the pool against the same dependency as its queries", async () => {
    const pg = fakePg();
    instrumentPg({ log: quiet, moduleImpl: pg.module });
    const Pool = pg.module.Pool as unknown as new () => { connect: () => Promise<unknown> };
    const pool = new Pool();

    const ctx = enterRequest();
    const client = (await pool.connect()) as { query: (...a: unknown[]) => unknown };
    await client.query("select 1");

    // One entry, not two: the wait and the query belong to the same dependency.
    expect(ctx.work?.size).toBe(1);
    const work = ctx.work?.get("postgres");
    expect(work?.calls).toBe(1);
    expect(work?.waitMs).toBeGreaterThanOrEqual(20);
  });

  it("counts the wait even when the pool gives up, which is the case worth seeing", async () => {
    const pg = fakePg();
    (pg.module.Pool.prototype as Record<string, unknown>).connect = (): Promise<unknown> =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout exceeded")), 20));
    instrumentPg({ log: quiet, moduleImpl: pg.module });
    const Pool = pg.module.Pool as unknown as new () => { connect: () => Promise<unknown> };

    const ctx = enterRequest();
    await expect(new Pool().connect()).rejects.toThrow("timeout exceeded");
    expect(ctx.work?.get("postgres")?.waitMs).toBeGreaterThanOrEqual(15);
  });

  it("does not count waiting outside a request", async () => {
    const pg = fakePg();
    instrumentPg({ log: quiet, moduleImpl: pg.module });
    const Pool = pg.module.Pool as unknown as new () => { connect: () => Promise<unknown> };
    await new Pool().connect(); // at startup, belonging to no endpoint
  });

  it("wraps the pool once, however many times it is instrumented", () => {
    const pg = fakePg();
    instrumentPg({ log: quiet, moduleImpl: pg.module });
    const wrapped = pg.module.Pool.prototype.connect;
    instrumentPg({ log: quiet, moduleImpl: pg.module });
    expect(pg.module.Pool.prototype.connect).toBe(wrapped);
  });
});
