import { AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { currentContext, enterRequest } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { instrumentPg } from "../src/instrument/pg.ts";
import type { Logger } from "../src/log.ts";
import { testConfig } from "./support/agent-config.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };

/**
 * What the instrumentation handed to `internalError`, as a failure of its own. Until gh-670 such a failure was only
 * logged; a test that is not about one checks this stays empty, so a failure no test asked for is not hidden by
 * being counted instead.
 */
const handed: unknown[] = [];
const deps = {
  log: quiet,
  internalError: (err: unknown): void => {
    handed.push(err);
  },
};

afterEach(() => {
  expect(handed.splice(0), "the instrumentation failed while recording").toEqual([]);
});

/** What was handed to `internalError` since the last look, taken, so the `afterEach` sees only what no test asked for. */
function handedOver(): unknown[] {
  return handed.splice(0);
}

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
  const version = instrumentPg({ ...deps, moduleImpl: pg.module });
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
    instrumentPg({ ...deps, moduleImpl: pg.module });
    const wrapped = pg.module.Client.prototype.query;
    instrumentPg({ ...deps, moduleImpl: pg.module });
    expect(pg.module.Client.prototype.query).toBe(wrapped);
    expect(wrapped).not.toBe(first);
  });

  it("does nothing when there is no pg to instrument", () => {
    expect(instrumentPg({ ...deps, moduleImpl: {} })).toBeUndefined();
    expect(instrumentPg({ ...deps, moduleImpl: { Client: { prototype: {} } } })).toBeUndefined();
    expect(instrumentPg({ ...deps, moduleImpl: { Client: { prototype: { query: 42 } } } })).toBeUndefined();
  });
});

describe("waiting for a connection", () => {
  it("counts the time a request waited for the pool against the same dependency as its queries", async () => {
    const pg = fakePg();
    instrumentPg({ ...deps, moduleImpl: pg.module });
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
    instrumentPg({ ...deps, moduleImpl: pg.module });
    const Pool = pg.module.Pool as unknown as new () => { connect: () => Promise<unknown> };

    const ctx = enterRequest();
    await expect(new Pool().connect()).rejects.toThrow("timeout exceeded");
    expect(ctx.work?.get("postgres")?.waitMs).toBeGreaterThanOrEqual(15);
  });

  it("does not count waiting outside a request", async () => {
    const pg = fakePg();
    instrumentPg({ ...deps, moduleImpl: pg.module });
    const Pool = pg.module.Pool as unknown as new () => { connect: () => Promise<unknown> };
    await new Pool().connect(); // at startup, belonging to no endpoint
  });

  it("wraps the pool once, however many times it is instrumented", () => {
    const pg = fakePg();
    instrumentPg({ ...deps, moduleImpl: pg.module });
    const wrapped = pg.module.Pool.prototype.connect;
    instrumentPg({ ...deps, moduleImpl: pg.module });
    expect(pg.module.Pool.prototype.connect).toBe(wrapped);
  });
});

/**
 * A pool that behaves like the real one under contention: `connect` queues its callback when no client is free,
 * and the queue is drained later, from whoever releases a connection. `query`'s callback is fired from the
 * connection's own timer, not the caller's. Both are context jumps, and both used to send a request's queries to
 * a different request.
 */
function contendedPg(concurrency: number) {
  const queue: Array<(err: unknown, client: unknown) => void> = [];
  let free = concurrency;

  class Client {
    query(...args: unknown[]): unknown {
      const cb = args.at(-1);
      if (typeof cb === "function") {
        setTimeout(() => (cb as (e: unknown, r: unknown) => void)(null, { rows: [] }), 1);
        return undefined;
      }
      return Promise.resolve({ rows: [] });
    }
  }
  const release = () => {
    const next = queue.shift();
    if (next) setTimeout(() => next(null, new Client()), 0);
    else free += 1;
  };
  class Pool {
    connect(cb?: (err: unknown, client: unknown, done: () => void) => void): unknown {
      const hand = (resolve: (c: unknown) => void) => {
        if (free > 0) {
          free -= 1;
          setTimeout(() => resolve(new Client()), 0);
        } else {
          queue.push((_e, client) => resolve(client));
        }
      };
      if (cb) {
        hand((client) => cb(null, client, release));
        return undefined;
      }
      return new Promise(hand);
    }
  }
  return {
    module: {
      Client: Client as unknown as { prototype: Record<string, unknown> },
      Pool: Pool as unknown as { prototype: Record<string, unknown> },
    },
    release,
  };
}

describe("attribution under pool contention", () => {
  it("gives each request its own queries, however long it waited for a connection", async () => {
    const pg = contendedPg(2); // two connections for ten requests
    instrumentPg({ ...deps, moduleImpl: pg.module });
    const Pool = pg.module.Pool as unknown as new () => {
      connect: (cb: (err: unknown, client: { query: (...a: unknown[]) => unknown }, done: () => void) => void) => void;
    };
    const pool = new Pool();

    // Ten concurrent "requests", each opening its own context and making two queries, the way pool.query() does.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => {
        const ctx = enterRequest();
        return new Promise<number>((resolve) => {
          pool.connect((_err, client, done) => {
            client.query("select 1", () => {
              client.query("select 2", () => {
                done();
                resolve(ctx.work?.get("postgres")?.calls ?? 0);
              });
            });
          });
        });
      }),
    );

    // Every request made exactly two queries, so every request must report two. Before the fix, eight reported
    // none and two reported everyone else's.
    expect(results).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });
});

describe("what the agent says it did", () => {
  it("says nothing more when asked to instrument the same driver again", () => {
    const pg = fakePg();
    instrumentPg({ ...deps, moduleImpl: pg.module });

    const lines: string[] = [];
    const noisy = { warn: (m: string) => lines.push(m), debug: (m: string) => lines.push(m) };
    instrumentPg({ ...deps, log: noisy, moduleImpl: pg.module });

    expect(lines.filter((l) => l.includes("instrumented pg"))).toHaveLength(0);
  });
});

/** The same cast the tests above use, named once because the profile tests all need it. */
const clientOf = (module: { Client: { prototype: Record<string, unknown> } }) =>
  new (module.Client as unknown as new () => { query: (...a: unknown[]) => unknown })();

describe("instrumentPg, building the profile", () => {
  it("records what a query was, not just that there was one", async () => {
    const pg = fakePg();
    const fingerprints = new FingerprintCache();
    instrumentPg({ ...deps, moduleImpl: pg.module, fingerprints });
    const client = clientOf(pg.module);
    const ctx = enterRequest();
    await client.query("SELECT id FROM products WHERE id = $1", [7]);
    await client.query("SELECT id FROM products WHERE id = $1", [9]);
    const operations = [...(ctx.operations?.values() ?? [])];
    expect(operations).toHaveLength(1);
    expect(operations[0]?.text).toBe("SELECT id FROM products WHERE id = ?");
    expect(operations[0]?.count).toBe(2);
    expect(operations[0]?.kind).toBe("query");
  });

  it("counts a failed query as an error on its fingerprint", async () => {
    const pg = fakePg();
    const fingerprints = new FingerprintCache();
    instrumentPg({ ...deps, moduleImpl: pg.module, fingerprints });
    const client = clientOf(pg.module);
    const ctx = enterRequest();
    await (client.query("boom") as Promise<unknown>).catch(() => {});
    const operations = [...(ctx.operations?.values() ?? [])];
    expect(operations[0]?.errors).toBe(1);
  });

  it("normalises one query text once, however many times it runs", async () => {
    const pg = fakePg();
    const fingerprints = new FingerprintCache();
    instrumentPg({ ...deps, moduleImpl: pg.module, fingerprints });
    const client = clientOf(pg.module);
    enterRequest();
    for (let i = 0; i < 50; i++) await client.query("SELECT id FROM t WHERE id = $1", [i]);
    expect(fingerprints.misses).toBe(1);
  });

  it("does not look at the query text when no profile is being built", async () => {
    const pg = fakePg();
    instrumentPg({ ...deps, moduleImpl: pg.module });
    const client = clientOf(pg.module);
    const ctx = enterRequest();
    await client.query("SELECT id FROM t WHERE id = $1", [1]);
    expect(ctx.operations).toBeUndefined();
    // The dependency counters are unaffected: the profile is an addition, not a replacement.
    expect(pgWork(ctx).calls).toBe(1);
  });

  it("attributes nothing to a query made outside a request", async () => {
    const pg = fakePg();
    const fingerprints = new FingerprintCache();
    instrumentPg({ ...deps, moduleImpl: pg.module, fingerprints });
    const client = clientOf(pg.module);
    await client.query("SELECT 1 FROM startup");
    // Nothing threw and nothing was attributed: a query at startup belongs to no endpoint.
    expect(fingerprints.size).toBe(0);
  });

  it("runs the query untouched when fingerprinting throws", async () => {
    const pg = fakePg();
    const exploding = {
      get: () => {
        throw new Error("normalisation broke");
      },
    } as unknown as FingerprintCache;
    instrumentPg({ ...deps, moduleImpl: pg.module, fingerprints: exploding });
    const client = clientOf(pg.module);
    enterRequest();
    // The application gets its rows: an agent bug must never change what the application's query does.
    const rows = client.query("SELECT id FROM t WHERE id = $1", [1]) as Promise<unknown>;
    await expect(rows).resolves.toEqual({ rows: [{ ok: 1 }] });
    // And the bug is the instrumentation's own, counted as one (ADR 0161, gh-670).
    expect(handedOver()).toEqual([new Error("normalisation broke")]);
  });
});

/**
 * `product.md:77` asks for the identity of an error and not only its count, and the cloud's hypothesis about
 * a failing operation had no evidence to read until this existed (gh-338, gh-337).
 */
describe("a query that fails", () => {
  function withErrors() {
    const pg = fakePg();
    const fingerprints = new FingerprintCache();
    const errors = new ErrorFingerprintCache();
    instrumentPg({ ...deps, moduleImpl: pg.module, fingerprints, errors });
    return { pg, errors };
  }

  it("records what it threw, beside the query itself", async () => {
    const { pg } = withErrors();
    const ctx = enterRequest();
    const client = new (pg.module.Client as unknown as new () => { query: (s: string) => Promise<unknown> })();

    await expect(client.query("boom")).rejects.toThrow("query failed");

    const operations = [...(ctx.operations?.values() ?? [])];
    const query = operations.find((o) => o.kind === "query");
    const error = operations.find((o) => o.kind === "error");
    if (!query || !error) {
      throw new Error(`operations = ${JSON.stringify(operations)}, want one of each`);
    }
    // Both: how often this query runs, and how often this error happens, are different questions.
    expect(query.errors).toBe(1);
    expect(error.text).toContain("query failed");
    expect(error.errors).toBe(1);
  });

  it("records nothing extra when the query succeeds", async () => {
    const { pg } = withErrors();
    const ctx = enterRequest();
    const client = new (pg.module.Client as unknown as new () => { query: (s: string) => Promise<unknown> })();

    await client.query("SELECT 1");

    const kinds = [...(ctx.operations?.values() ?? [])].map((o) => o.kind);
    expect(kinds).toEqual(["query"]);
  });

  it("lets the application see exactly the error it would have seen", async () => {
    const { pg } = withErrors();
    enterRequest();
    const client = new (pg.module.Client as unknown as new () => { query: (s: string) => Promise<unknown> })();

    // The whole point of invariant 2: measuring must not change what is being measured.
    await expect(client.query("boom")).rejects.toThrow("query failed");
  });
});

/**
 * Invariant 2 on every path a query takes, and `product.md:241`: «it never throws exceptions into the user's
 * code nor breaks the application». Until gh-652 only the promise form of `client.query` had a test of it, and
 * turning the callback form's `catch` into a rethrow left every test green — the form `pg-pool` uses for every
 * `pool.query()`, with a callback or without (`pg-pool/index.js:467`). The wait for a connection had no `catch`
 * to turn at all: a throw there ended the process, or kept the connection from ever going back to the pool.
 *
 * And the other half of the invariant: «An internal failure disables the instrumentation». Each failure is handed
 * to the agent's `internalError`, once per hook that failed, which counts it and at the tenth disables the
 * instrumentation; until gh-670 pg's were only logged (ADR 0161).
 */
describe("a failure while recording never reaches the application", () => {
  const SQL = "SELECT id FROM t WHERE id = $1";
  const ROWS = { rows: [{ ok: 1 }] };

  type Query = (...args: unknown[]) => unknown;
  /** One way of asking for rows, reduced to a promise of what the application got. */
  type Form = [name: string, run: (query: Query) => Promise<unknown>];
  /**
   * One failure of the instrumentation's own code: what the test hands `instrumentPg` and the request, what
   * `internalError` is handed for it, and how many of the hooks a `pool.query()` goes through consult what fails.
   */
  type Failure = [
    name: string,
    make: () => { fingerprints: FingerprintCache | undefined; excluded: { has(target: string): boolean } | undefined },
    thrown: Error,
    poolHooks: number,
  ];

  /** The two forms `pg` accepts, as a table: the symmetry is the shape of the test, not something to remember. */
  const forms: Form[] = [
    ["promise", (query) => query(SQL, [1]) as Promise<unknown>],
    [
      "callback",
      (query) =>
        new Promise((resolve, reject) => {
          query(SQL, [1], (err: unknown, res: unknown) => (err ? reject(err) : resolve(res)));
        }),
    ],
  ];

  /** The two forms of asking `pg`'s pool for a client, reduced to a promise of what the application got. */
  type Connect = [name: string, connect: (pool: pg.Pool) => Promise<unknown>];
  const connects: Connect[] = [
    ["promise", (pool) => pool.connect()],
    [
      "callback",
      (pool) =>
        new Promise((resolve, reject) => {
          pool.connect((err, client) => (err ? reject(err) : resolve(client)));
        }),
    ],
  ];

  function explodingExclusions(): { has(target: string): boolean } {
    return {
      has: () => {
        throw new Error("exclusion broke");
      },
    };
  }

  /**
   * Two places the instrumentation's own code can fail while it records, and every recording in `pg.ts` goes
   * through at least one: the query's fingerprint, and the request's exclusion list, which `recordCallIn` and
   * `recordWaitIn` consult before anything else. Neither stands in for the driver: both are the agent's.
   *
   * A `pool.query()` goes through two hooks, the wait for its connection and the query, and only the query is
   * fingerprinted; the exclusion list is consulted by both.
   */
  const failures: Failure[] = [
    [
      "fingerprinting throws",
      () => ({
        // Only `get` is ever called on it.
        fingerprints: {
          get: () => {
            throw new Error("normalisation broke");
          },
        } as unknown as FingerprintCache,
        excluded: undefined,
      }),
      new Error("normalisation broke"),
      1,
    ],
    [
      "the exclusion list throws",
      () => ({ fingerprints: undefined, excluded: explodingExclusions() }),
      new Error("exclusion broke"),
      2,
    ],
  ];

  /**
   * A connection with no socket that calls back the way `pg` does: later, from its own event, never from the
   * caller's stack. What escapes a callback it calls is what `pg` rethrows on `process.nextTick`
   * (`pg/lib/query.js:140-146`), and the process ends; here it lands in `escaped`, so a test can say it
   * happened. The four methods are the ones `pg-pool` calls on the `Client` it is given.
   */
  function connection(refusal?: Error) {
    let caught: (err: unknown) => void = () => {};
    const escaped = new Promise<unknown>((resolve) => {
      caught = resolve;
    });
    const later = (call: () => void): void => {
      setImmediate(() => {
        try {
          call();
        } catch (err) {
          caught(err);
        }
      });
    };
    class Connection extends EventEmitter {
      connect(cb: (err?: Error) => void): void {
        later(() => cb(refusal));
      }
      query(...args: unknown[]): unknown {
        const cb = args.at(-1);
        if (typeof cb !== "function") return Promise.resolve(ROWS);
        later(() => (cb as (err: unknown, res: unknown) => void)(null, ROWS));
        return undefined;
      }
      end(cb?: () => void): void {
        later(() => cb?.());
      }
    }
    return { Connection, escaped };
  }

  /** What reached the application, unless something escaped into the connection first: then that is the red. */
  function unlessEscaped(app: Promise<unknown>, escaped: Promise<unknown>): Promise<unknown> {
    return Promise.race([
      app,
      escaped.then((err) => {
        throw new Error(`escaped into the driver instead: ${err instanceof Error ? err.message : String(err)}`);
      }),
    ]);
  }

  /** `query`, bound to whatever carries it: a client or a pool. */
  function queryOf(target: object): Query {
    const query = (target as { query: Query }).query;
    return query.bind(target);
  }

  /**
   * `pg`'s real pool over the connection above: `pg-pool` builds its clients from the `Client` in its options
   * (`pg-pool/index.js:95`), and everything else — acquiring, calling back, releasing — is its own code. A
   * subclass per test, so each test patches a `connect` of its own and not the module's.
   */
  function realPool(Connection: new () => EventEmitter) {
    class Pool extends pg.Pool {}
    // Typed as pg's own client; this one has only the four methods pg-pool calls.
    const pool = new Pool({ Client: Connection as unknown as new () => pg.ClientBase });
    return { Pool, pool };
  }

  describe.each(failures)("when %s", (_failure, make, thrown, poolHooks) => {
    it.each(forms)("a client's %s query gets its rows, and nothing escapes into the driver", async (_form, run) => {
      const { Connection, escaped } = connection();
      const { fingerprints, excluded } = make();
      instrumentPg({ ...deps, moduleImpl: { Client: Connection }, fingerprints });
      enterRequest(undefined, undefined, excluded);
      await expect(unlessEscaped(run(queryOf(new Connection())), escaped)).resolves.toEqual(ROWS);
      // Counted once, as the instrumentation's own failure (ADR 0161, gh-670).
      expect(handedOver()).toEqual([thrown]);
    });

    it.each(forms)("pg's pool.query() gets its rows in the %s form, and nothing escapes", async (_form, run) => {
      const { Connection, escaped } = connection();
      const { fingerprints, excluded } = make();
      const { Pool, pool } = realPool(Connection);
      instrumentPg({ ...deps, moduleImpl: { Client: Connection, Pool }, fingerprints });
      enterRequest(undefined, undefined, excluded);
      await expect(unlessEscaped(run(queryOf(pool)), escaped)).resolves.toEqual(ROWS);
      // Once per hook that failed: the query's, and the wait's when the exclusion list is what fails.
      expect(handedOver()).toEqual(Array.from({ length: poolHooks }, () => thrown));
      // The connection went back: a pool with one checked out would wait for it here for ever.
      await pool.end();
    });
  });

  // Reading where a client points is the instrumentation's work as much as recording is, and until gh-662 it was
  // the one part of it before any `try`: a client whose `host` throws threw into the application's own call.
  it.each(forms)("a client whose target cannot be read gets its rows in the %s form", async (_form, run) => {
    const { Connection, escaped } = connection();
    class Unreadable extends Connection {
      get host(): string {
        throw new Error("host broke");
      }
    }
    instrumentPg({ ...deps, moduleImpl: { Client: Unreadable } });
    enterRequest();
    await expect(unlessEscaped(run(queryOf(new Unreadable())), escaped)).resolves.toEqual(ROWS);
    expect(handedOver()).toEqual([new Error("host broke")]);
  });

  describe("pg's pool.connect(), when the exclusion list throws", () => {
    it.each(connects)("hands over a client the application can release, %s form", async (_form, connect) => {
      const { Connection, escaped } = connection();
      const { Pool, pool } = realPool(Connection);
      instrumentPg({ ...deps, moduleImpl: { Client: Connection, Pool } });
      enterRequest(undefined, undefined, explodingExclusions());
      const client = await unlessEscaped(connect(pool), escaped);
      expect(client).toBeInstanceOf(Connection);
      expect(handedOver()).toEqual([new Error("exclusion broke")]);
      (client as pg.PoolClient).release();
      await pool.end();
    });

    it.each(connects)("lets the connection's own failure through, %s form", async (_form, connect) => {
      const refused = new Error("connection refused");
      const { Connection, escaped } = connection(refused);
      const { Pool, pool } = realPool(Connection);
      instrumentPg({ ...deps, moduleImpl: { Client: Connection, Pool } });
      enterRequest(undefined, undefined, explodingExclusions());
      // The application's own error, not the instrumentation's.
      await expect(unlessEscaped(connect(pool), escaped)).rejects.toBe(refused);
      expect(handedOver()).toEqual([new Error("exclusion broke")]);
      await pool.end();
    });
  });

  /**
   * What a guard catches can be the application's own value: a client's `host` is the application's getter when its
   * `Client` has one. `String` throws on a value with no prototype, and until gh-670 the guards of the wait described
   * what they caught with it, so the description threw out of the `catch`: in the promise form the application got
   * a `TypeError` instead of its client, which never went back to the pool, and in the callback form it escaped into
   * the driver. `internalError` describes inside a `try` of its own (gh-664), so pg's guards hand it what they caught
   * and describe nothing.
   */
  describe("a client whose target cannot be read, with a value that cannot be described", () => {
    function unreadable() {
      const thrown: unknown = Object.create(null);
      const { Connection, escaped } = connection();
      class Unreadable extends Connection {
        get host(): string {
          throw thrown;
        }
      }
      return { thrown, Unreadable, escaped };
    }

    it.each(forms)("a %s query gets its rows, and the value is handed over as it was thrown", async (_form, run) => {
      const { thrown, Unreadable, escaped } = unreadable();
      instrumentPg({ ...deps, moduleImpl: { Client: Unreadable } });
      enterRequest();
      await expect(unlessEscaped(run(queryOf(new Unreadable())), escaped)).resolves.toEqual(ROWS);
      const got = handedOver();
      expect(got).toHaveLength(1);
      expect(got[0]).toBe(thrown);
    });

    it.each(connects)(
      "pool.connect() hands over its client in the %s form, and the value as it was thrown",
      async (_form, connect) => {
        const { thrown, Unreadable, escaped } = unreadable();
        const { Pool, pool } = realPool(Unreadable);
        instrumentPg({ ...deps, moduleImpl: { Client: Unreadable, Pool } });
        enterRequest();
        const client = await unlessEscaped(connect(pool), escaped);
        expect(client).toBeInstanceOf(Unreadable);
        const got = handedOver();
        expect(got).toHaveLength(1);
        expect(got[0]).toBe(thrown);
        (client as pg.PoolClient).release();
        await pool.end();
      },
    );
  });

  /**
   * `connect`'s preparation has a `catch` of its own (gh-662), and the one step in it that can fail is Node's
   * `AsyncResource.bind`, which ties the application's callback to its request: the rest reads an array and the
   * request's store. Nothing of the agent's or the application's makes it throw, so it is made to, once, from here.
   */
  it("a connect callback the instrumentation cannot bind still gets its client, and the failure is counted", async () => {
    const broke = new Error("bind broke");
    const bind = vi.spyOn(AsyncResource, "bind").mockImplementationOnce(() => {
      throw broke;
    });
    try {
      const { Connection, escaped } = connection();
      const { Pool, pool } = realPool(Connection);
      instrumentPg({ ...deps, moduleImpl: { Client: Connection, Pool } });
      enterRequest();
      const client = await unlessEscaped(
        new Promise((resolve, reject) => {
          pool.connect((err, c) => (err ? reject(err) : resolve(c)));
        }),
        escaped,
      );
      expect(client).toBeInstanceOf(Connection);
      expect(handedOver()).toEqual([broke]);
      (client as pg.PoolClient).release();
      await pool.end();
    } finally {
      bind.mockRestore();
    }
  });

  /**
   * The count itself, through the real `Agent` and `pg`'s real pool: what the guards hand over is the agent's
   * `internalError`, which counts it in `internalErrors`, sends it in the batch and at the tenth disables the
   * instrumentation (invariant 2, `product.md:241`, ADR 0161). The failure is the one the other two observers' test
   * injects: the exclusion list of the context the agent opened for the request, made to fail from the handler.
   */
  it("through the agent, each failure counts, the tenth disables the instrumentation, and every request is answered", async () => {
    const { Connection, escaped } = connection();
    const { Pool, pool } = realPool(Connection);
    const accepted = (async () =>
      new Response(JSON.stringify({ accepted: 1, inserted: 1 }), { status: 202 })) as unknown as typeof fetch;
    const agent = new Agent(testConfig("http://cloud.invalid", { intervalMs: 60_000, instrument: new Set(["pg"]) }), {
      log: quiet,
      fetchImpl: accepted,
      pgModule: { Client: Connection, Pool },
    });
    // The application: every request asks the pool for rows, the way most do.
    const app = http.createServer((_req, res) => {
      const ctx = currentContext();
      if (ctx) ctx.excluded = explodingExclusions();
      pool.query(SQL, [1]).then(
        (rows) => res.end(JSON.stringify(rows)),
        (err: unknown) => res.writeHead(500).end(String(err)),
      );
    });
    await new Promise<void>((ready) => app.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const answer = (): Promise<unknown> =>
      unlessEscaped(
        fetch(url).then((res) => res.json()),
        escaped,
      );
    agent.start();
    try {
      // One request: the wait and the query each fail to record, and each is one internal error.
      await expect(answer()).resolves.toEqual(ROWS);
      expect(agent.stats).toMatchObject({ internalErrors: 2, disabled: false });
      // Four more take the count to ten, and the tenth disables the instrumentation.
      for (let i = 0; i < 4; i++) await expect(answer()).resolves.toEqual(ROWS);
      expect(agent.stats).toMatchObject({ internalErrors: 10, disabled: true });
      // Disabled is off: no request is observed, so nothing fails to record or is counted, and every one is answered.
      for (let i = 0; i < 5; i++) await expect(answer()).resolves.toEqual(ROWS);
      expect(agent.stats.internalErrors).toBe(10);
    } finally {
      await agent.stop();
      await new Promise<void>((closed) => app.close(() => closed()));
      await pool.end();
    }
  });
});

/**
 * Invariant 2 from the other side: what pg throws, or what an application callback it calls throws, is the
 * application's, and reaches it as it would with no instrumentation — once. Until gh-662 the callback forms called
 * pg inside the `try` that exists for the instrumentation's own failures, and its `catch` took the application's
 * throw for one of those and called pg a second time. An ended pool calls a `connect` callback before returning
 * (`pg-pool/index.js:190-194`), so a callback that rethrows its error, the usual pattern, ran twice.
 */
describe("what pg throws or calls back reaches the application once", () => {
  type Call = (...args: unknown[]) => unknown;
  /**
   * What the application saw: how many times the row's code ran — the application's callback on the pool, pg's
   * own `query` on the client, where pg throws before it calls anything back — and what was thrown at it.
   */
  interface Seen {
    runs: number;
    thrown: unknown;
  }

  /** What a call threw at its caller, synchronously, as something two runs of the same call can share. */
  function thrownBy(call: () => unknown): unknown {
    try {
      call();
    } catch (err) {
      return err instanceof Error ? `${err.name}: ${err.message}` : err;
    }
    return "nothing";
  }

  /**
   * `pg`'s real pool, ended before it ever built a client, so no connection is made. The `Client` is a subclass of
   * `pg`'s own so that instrumenting it patches the subclass and not the module every other test shares.
   */
  async function endedPool(instrumented: boolean): Promise<pg.Pool> {
    class Client extends pg.Client {}
    class Pool extends pg.Pool {}
    if (instrumented) instrumentPg({ ...deps, moduleImpl: { Client, Pool } });
    const pool = new Pool();
    await pool.end();
    return pool;
  }

  /** `pg`'s real client, never connected, with a count of how many times pg's own `query` is entered. */
  function countedClient(instrumented: boolean): { query: Call; entered: () => number } {
    let entered = 0;
    const query = pg.Client.prototype.query as Call;
    class Client extends pg.Client {}
    // Its own `query`, so it is this one the instrumentation wraps, and what is counted is the calls that reach pg.
    (Client.prototype as unknown as Record<string, unknown>).query = function (this: unknown, ...args: unknown[]) {
      entered += 1;
      return query.apply(this, args);
    };
    if (instrumented) instrumentPg({ ...deps, moduleImpl: { Client } });
    const client = new Client();
    return { query: (client as unknown as { query: Call }).query.bind(client), entered: () => entered };
  }

  /** One call of the application's, run against pg with the instrumentation or without it. */
  type Row = [name: string, run: (instrumented: boolean) => Promise<Seen>];
  const rows: Row[] = [
    [
      "pool.connect(cb) on an ended pool, whose callback rethrows",
      async (instrumented) => {
        const pool = await endedPool(instrumented);
        let runs = 0;
        const thrown = thrownBy(() =>
          pool.connect((err) => {
            runs += 1;
            if (err) throw err;
          }),
        );
        return { runs, thrown };
      },
    ],
    [
      "pool.query(sql, cb) on an ended pool, whose callback rethrows",
      async (instrumented) => {
        const pool = await endedPool(instrumented);
        let runs = 0;
        const thrown = thrownBy(() =>
          pool.query("SELECT 1", (err) => {
            runs += 1;
            if (err) throw err;
          }),
        );
        return { runs, thrown };
      },
    ],
    [
      "client.query(null, cb), which pg refuses before calling back",
      async (instrumented) => {
        const { query, entered } = countedClient(instrumented);
        const thrown = thrownBy(() => query(null, () => {}));
        return { runs: entered(), thrown };
      },
    ],
    [
      "client.query(null), the same in the promise form",
      async (instrumented) => {
        const { query, entered } = countedClient(instrumented);
        const thrown = thrownBy(() => query(null));
        return { runs: entered(), thrown };
      },
    ],
  ];

  type Where = [name: string, enter: () => void];
  const where: Where[] = [
    [
      "inside a request",
      () => {
        enterRequest();
      },
    ],
    ["outside a request", () => expect(currentContext(), "has to run outside a request").toBeUndefined()],
  ];

  describe.each(where)("%s", (_where, enter) => {
    it.each(rows)("%s: as many runs and the same error as with no instrumentation", async (_row, run) => {
      const bare = await run(false);
      expect(bare.runs, "what pg does on its own").toBe(1);
      enter();
      expect(await run(true)).toEqual(bare);
    });
  });
});
