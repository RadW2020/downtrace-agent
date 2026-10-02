import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CallFingerprints } from "../src/calls.ts";
import { currentContext, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { Excluded } from "../src/exclude.ts";
import { FineRegister } from "../src/fine.ts";
import { instrumentHttp } from "../src/instrument/http.ts";
import type { Logger } from "../src/log.ts";
import { escapedFrom } from "./support/escaped.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };

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

afterEach(() => {
  expect(failures.splice(0), "the observer failed while recording").toEqual([]);
});

let server: http.Server;
let port: number;
let stop: () => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/boom") {
      res.writeHead(503).end("no");
      return;
    }
    if (req.url === "/reset") {
      req.socket.destroy(); // the connection dies after the request was sent: undici publishes an error
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  port = (server.address() as AddressInfo).port;
  stop = instrumentHttp(deps);
});

afterAll(async () => {
  stop();
  await new Promise<void>((done) => server.close(() => done()));
});

/** Outgoing HTTP as one request's work, once the responses have been observed. */
async function workOf(ctx: RequestContext) {
  await new Promise((r) => setTimeout(r, 50));
  return [...(ctx.work ?? new Map())].map(([, w]) => w).filter((w) => w.kind === "http");
}

/** What a request ran, once the channels have settled. */
async function opsOf(ctx: RequestContext) {
  await new Promise((r) => setTimeout(r, 50));
  return [...(ctx.operations?.values() ?? [])];
}

describe("instrumentHttp", () => {
  it("records a fetch call against the request that made it, under the host it asked for", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/a`);
    const [dep] = await workOf(ctx);
    expect(dep?.target).toBe(`127.0.0.1:${port}`);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(0);
    expect(dep?.ms).toBeGreaterThan(0);
  });

  it("counts a 5xx from the dependency as a failure of that dependency", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/boom`);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("counts a node:http call that never connected", async () => {
    const ctx = enterRequest();
    await new Promise<void>((done) => {
      const request = http.get({ host: "127.0.0.1", port: 1, path: "/nowhere" });
      request.on("error", () => done());
    });
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("counts a fetch that never connected, which undici does not publish", async () => {
    const ctx = enterRequest();
    await expect(fetch("http://127.0.0.1:1/nowhere")).rejects.toThrow();
    const [dep] = await workOf(ctx);
    expect(dep?.target).toBe("127.0.0.1:1");
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("does not count a successful fetch twice, now that fetch is wrapped as well as listened to", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/a`);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
  });

  it("does not count a 5xx twice either: the channels saw it, so the wrapper stays out", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/boom`);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("puts fetch back when it stops observing", async () => {
    const before = globalThis.fetch;
    const undo = instrumentHttp(deps);
    expect(globalThis.fetch).not.toBe(before);
    undo();
    expect(globalThis.fetch).toBe(before);
  });

  it("groups calls by host, so two dependencies are not one", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/a`);
    await fetch(`http://localhost:${port}/a`);
    const deps = await workOf(ctx);
    expect(deps.map((d) => d.target).sort()).toEqual([`127.0.0.1:${port}`, `localhost:${port}`]);
  });

  it("records the node:http client too, under the same host label as fetch would", async () => {
    const ctx = enterRequest();
    await new Promise<void>((done) => {
      http.get({ host: "127.0.0.1", port, path: "/b" }, (res) => {
        res.resume();
        res.on("end", () => done());
      });
    });
    const [dep] = await workOf(ctx);
    expect(dep?.target).toBe(`127.0.0.1:${port}`);
    expect(dep?.calls).toBe(1);
  });

  it("counts several calls to the same host as several calls of one dependency", async () => {
    const ctx = enterRequest();
    await Promise.all([
      fetch(`http://127.0.0.1:${port}/a`),
      fetch(`http://127.0.0.1:${port}/a`),
      fetch(`http://127.0.0.1:${port}/a`),
    ]);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(3);
  });

  it("ignores calls made outside a request", async () => {
    // No enterRequest here: this call belongs to no endpoint, like a health probe at startup.
    const response = await fetch(`http://127.0.0.1:${port}/a`);
    expect(response.status).toBe(200);
  });
});

/**
 * ERR-01, the half this ticket adds: an outgoing call that fails inside a request is an operation with its
 * identity, not only a failed call of the dependency. The identity is the one a failed query already had
 * (gh-338): the same signature, the same bounds, beside the same counters.
 */
describe("a call that fails", () => {
  const errors = new ErrorFingerprintCache();

  beforeEach(() => {
    // One observer at a time: the module's is still on, and two would count the same call twice.
    stop();
    stop = instrumentHttp({ ...deps, errors });
  });

  afterEach(() => {
    stop();
    stop = instrumentHttp(deps);
  });

  it("records what a fetch that never connected threw, beside the failed call", async () => {
    const ctx = enterRequest();
    await expect(fetch("http://127.0.0.1:1/nowhere")).rejects.toThrow();
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    const error = (await opsOf(ctx)).find((o) => o.kind === "error");
    expect(error, "the rejection is identified, not only counted").toBeDefined();
    expect(error?.errors).toBe(1);
    // The real case the sanitising has to stand up to: undici publishes nothing for a connection that never
    // happens, the rejection carries no cause a hook can read, and its stack is what it is. The identity is
    // coarse — the type and the message, no place in the application's code — and this pins it, so a change
    // in either half of it is a change in what an error is (gh-907).
    expect(error?.text).toBe("TypeError: fetch failed");
  });

  it("records what a node:http request that was refused threw, with the host kept out of the identity", async () => {
    const ctx = enterRequest();
    await new Promise<void>((done) => {
      const request = http.get({ host: "127.0.0.1", port: 1, path: "/nowhere" });
      request.on("error", () => done());
    });
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    const error = (await opsOf(ctx)).find((o) => o.kind === "error");
    expect(error, "the refusal is identified, not only counted").toBeDefined();
    expect(error?.errors).toBe(1);
    expect(error?.text).toContain("ECONNREFUSED");
    // Invariant 5, asked of the identity: the message the driver writes carries the host it refused, and the
    // sanitising is what keeps it out.
    expect(error?.text).not.toContain("127.0.0.1");
  });

  it("records what a fetch whose connection was reset threw, once", async () => {
    const ctx = enterRequest();
    await expect(fetch(`http://127.0.0.1:${port}/reset`)).rejects.toThrow();
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    // Two hooks see this failure — the `undici:request:error` subscriber and the fetch's wrapper — and the
    // call is counted once, so the error is an operation once as well.
    const found = (await opsOf(ctx)).filter((o) => o.kind === "error");
    expect(found).toHaveLength(1);
    expect(found[0]?.errors).toBe(1);
    expect(found[0]?.text).toContain("other side closed");
  });

  it("records what the socket layer saw when a port that listened stops answering, once", async () => {
    // The port-1 refusal above is rejected by the client before any socket, and undici publishes nothing for
    // it. A port that has answered and stops is a refusal the socket layer reports, and the channel carries
    // it: the identity is the driver's, not the coarse rejection the app sees (gh-907).
    const stopped = http.createServer(() => {});
    await new Promise<void>((ready) => stopped.listen(0, "127.0.0.1", ready));
    const closed = (stopped.address() as AddressInfo).port;
    await new Promise<void>((done) => stopped.close(() => done()));
    const ctx = enterRequest();
    await expect(fetch(`http://127.0.0.1:${closed}/nowhere`)).rejects.toThrow();
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    // Two hooks see this failure — the `undici:request:error` subscriber and the fetch's wrapper — and the
    // call is counted once, so the error is an operation once as well.
    const found = (await opsOf(ctx)).filter((o) => o.kind === "error");
    expect(found).toHaveLength(1);
    expect(found[0]?.errors).toBe(1);
    expect(found[0]?.text).toContain("ECONNREFUSED");
    expect(found[0]?.text).not.toContain("127.0.0.1");
  });

  it("does not make an error of a 5xx the dependency answers: nobody threw anything", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/boom`);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    expect(ctx.operations, "no identity is invented for an answer").toBeUndefined();
  });

  it("counts a fingerprint that throws as an internal error, and the application keeps its own", async () => {
    const exploded = new Error("fingerprint broke");
    stop();
    stop = instrumentHttp({
      ...deps,
      errors: {
        get: () => {
          throw exploded;
        },
      } as unknown as ErrorFingerprintCache,
    });
    const ctx = enterRequest();
    // The application gets exactly the rejection it would have had (invariant 2).
    await expect(fetch("http://127.0.0.1:1/nowhere")).rejects.toThrow();
    const [dep] = await workOf(ctx);
    // The failed call is counted; the operation the fingerprint is for is not.
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
    expect(ctx.operations).toBeUndefined();
    // And the bug is the instrumentation's own, counted once (ADR 0161).
    expect(failures.splice(0)).toEqual([exploded]);
  });
});

/**
 * What the operator excluded is not looked at (`product.md:104`, ADR 0101): the failed call of an excluded
 * dependency is not counted, and neither is the error beside it, which a message of the driver writes with the
 * name of the destination in it.
 */
describe("a call that fails against a dependency the operator excluded", () => {
  const errors = new ErrorFingerprintCache();
  const excluded = new Excluded(["127.0.0.1:1"]);

  beforeEach(() => {
    stop();
    stop = instrumentHttp({ ...deps, errors });
  });

  afterEach(() => {
    stop();
    stop = instrumentHttp(deps);
  });

  it("withholds the error of a fetch that never connected, with the failed call it is beside", async () => {
    const ctx = enterRequest(undefined, undefined, excluded);
    await expect(fetch("http://127.0.0.1:1/nowhere")).rejects.toThrow();
    expect(await workOf(ctx), "an excluded dependency is not looked at at all").toEqual([]);
    expect(ctx.operations, "neither the identity of what it threw").toBeUndefined();
  });

  it("withholds the error of a node:http request that was refused, with the failed call it is beside", async () => {
    const ctx = enterRequest(undefined, undefined, excluded);
    await new Promise<void>((done) => {
      const request = http.get({ host: "127.0.0.1", port: 1, path: "/nowhere" });
      request.on("error", () => done());
    });
    expect(await workOf(ctx)).toEqual([]);
    expect(ctx.operations).toBeUndefined();
  });

  it("is a choice and not a blindness: the same call, unexcluded, leaves its error", async () => {
    const ctx = enterRequest();
    await expect(fetch("http://127.0.0.1:1/nowhere")).rejects.toThrow();
    const [dep] = await workOf(ctx);
    expect(dep?.errors).toBe(1);
    expect(
      (await opsOf(ctx)).some((o) => o.kind === "error"),
      "the unexcluded call is identified",
    ).toBe(true);
  });
});

/**
 * Invariant 2 on every path an outgoing call takes, and `product.md:241`: «it never throws exceptions into the
 * user's code nor breaks the application». Until gh-663 the subscribers recorded with no guard, and Node rethrows
 * a subscriber's throw on the next tick as an uncaught exception, which ends the process; the `fetch` wrapper
 * recorded inside its own `catch`, so a call that failed rejected with our error instead of its own.
 */
describe("a failure while recording never reaches the application", () => {
  const broken = new Error("exclusion broke");
  /**
   * The request's exclusion list, which `recordCallIn` consults before anything else (`context.ts:157`), and
   * every recording of this observer goes through it: the instrumentation's own code, not the driver's.
   */
  const exploding = {
    has: (): boolean => {
      throw broken;
    },
  };

  interface Answer {
    status: number;
    body: string;
  }
  /** What the application got, reduced to what two runs of the same call can share. */
  type Outcome = Answer | { name: string; message: string; code: unknown };

  const codeOf = (e: unknown): unknown => (e instanceof Error && "code" in e ? e.code : undefined);

  async function outcome(call: () => Promise<Answer>): Promise<Outcome> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof Error)) return { name: typeof err, message: String(err), code: undefined };
      return { name: err.name, message: err.message, code: codeOf(err) ?? codeOf(err.cause) };
    }
  }

  async function fetched(url: string): Promise<Answer> {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  }

  function got(options: http.RequestOptions): Promise<Answer> {
    return new Promise((resolve, reject) => {
      http
        .get(options, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject);
    });
  }

  /**
   * Every path of the observer, as a table, with how many of its hooks record on the way: the channels each one
   * publishes were measured on Node 24 and 26 and are the same. A reset goes through two, the
   * `undici:request:error` subscriber and the wrapper, because the first failed before it counted the call.
   */
  type Call = [name: string, run: () => Promise<Answer>, hooks: number];
  const calls: Call[] = [
    ["a fetch that is answered", () => fetched(`http://127.0.0.1:${port}/a`), 1],
    ["a fetch whose connection is reset", () => fetched(`http://127.0.0.1:${port}/reset`), 2],
    ["a fetch that never connects", () => fetched("http://127.0.0.1:1/nowhere"), 1],
    ["a node:http request that is answered", () => got({ host: "127.0.0.1", port, path: "/b" }), 1],
    ["a node:http request that is refused", () => got({ host: "127.0.0.1", port: 1, path: "/nowhere" }), 1],
  ];

  it.each(calls)("%s gets what it gets outside a request, and the failure is counted", async (_call, run, hooks) => {
    // The same call where the observer records nothing, which is what the application sees without it.
    expect(currentContext(), "the first call has to be made outside a request").toBeUndefined();
    const bare = await outcome(run);
    enterRequest(undefined, undefined, exploding);
    const { value: seen, escaped } = await escapedFrom(() => outcome(run));
    expect(seen).toEqual(bare);
    expect(escaped, "escaped as an uncaught exception").toEqual([]);
    // Handed to the agent's count of internal errors once per hook that failed, and nothing else was.
    expect(failures.splice(0)).toEqual(Array.from({ length: hooks }, () => broken));
  });
});

/**
 * DT-17, `product.md:142`: the detail of a request keeps its outgoing calls with their timings and overlaps.
 * Each call is an operation `call` — its method and the host it asked for — beside the counter of its
 * dependency, in what the request ran (the profile) and in the black box.
 */
describe("an outgoing call is an operation", () => {
  const calls = new CallFingerprints("call");

  beforeEach(() => {
    stop();
    stop = instrumentHttp({ ...deps, calls });
  });

  afterEach(() => {
    stop();
    stop = instrumentHttp(deps);
  });

  const callsOf = async (ctx: RequestContext) => (await opsOf(ctx)).filter((o) => o.kind === "call");

  it("records two concurrent fetches as one call run twice, overlapping in the black box", async () => {
    const fine = new FineRegister();
    const ctx = enterRequest(fine, performance.now());
    await Promise.all([
      fetch(`http://127.0.0.1:${port}/a`, { method: "POST", body: "{}" }),
      fetch(`http://127.0.0.1:${port}/a`, { method: "POST", body: "{}" }),
    ]);
    const [call] = await callsOf(ctx);
    expect(call).toMatchObject({ kind: "call", text: `POST 127.0.0.1:${port}`, count: 2, errors: 0 });
    fine.request("POST", "/checkout", 200, 0, 100, ctx.fineFrom, ctx.fineOps);
    const operations = fine.snapshot().requests[0]?.operations ?? [];
    expect(operations.map((o) => o.kind)).toEqual(["call", "call"]);
    const [first, second] = [...operations].sort((a, b) => a.startMs - b.startMs);
    // Started before the other ended: time the request waited on both at once, not one after the other.
    expect(first && second && second.startMs < first.endMs).toBe(true);
  });

  it("records the node:http client too, under the same label fetch would", async () => {
    const ctx = enterRequest();
    await new Promise<void>((done) => {
      http.get({ host: "127.0.0.1", port, path: "/b?secret=1" }, (res) => {
        res.resume();
        res.on("end", () => done());
      });
    });
    const [call] = await callsOf(ctx);
    // The method and the host: never the path, never the query string (invariant 5).
    expect(call?.text).toBe(`GET 127.0.0.1:${port}`);
    expect(JSON.stringify(call)).not.toContain("secret");
  });

  it("counts a call that failed as an error of the call, beside the error it threw", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/boom`);
    const [call] = await callsOf(ctx);
    // A 5xx is a failed execution of the call, not an error of its own: nobody threw anything.
    expect(call).toMatchObject({ count: 1, errors: 1 });
    expect((await opsOf(ctx)).filter((o) => o.kind === "error")).toEqual([]);
  });

  it("records a fetch that never connected as a failed call, which only the wrapper sees", async () => {
    const ctx = enterRequest();
    await expect(fetch("http://127.0.0.1:1/nowhere", { method: "PUT" })).rejects.toThrow();
    const [call] = await callsOf(ctx);
    expect(call).toMatchObject({ text: "PUT 127.0.0.1:1", count: 1, errors: 1 });
  });

  it("records nothing of a host the operator excluded: neither the call nor its counter", async () => {
    const ctx = enterRequest(undefined, undefined, new Excluded([`127.0.0.1:${port}`]));
    await fetch(`http://127.0.0.1:${port}/a`);
    expect(await workOf(ctx)).toEqual([]);
    expect(ctx.operations).toBeUndefined();
  });

  // Invariant 2: a failure while recording the operation is the instrumentation's own. It is counted, and the
  // application's call ends exactly as it would have.
  it("counts a register that throws as an internal error, and the application's call completes", async () => {
    const broken = new Error("the ring broke");
    const fine = new FineRegister();
    fine.operation = () => {
      throw broken;
    };
    const ctx = enterRequest(fine, performance.now());
    const response = await fetch(`http://127.0.0.1:${port}/a`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    await workOf(ctx);
    expect(failures.splice(0)).toEqual([broken]);
  });

  it("counts a fingerprint cache that throws as an internal error, and a fetch that failed rejects with its own", async () => {
    const broken = new Error("the cache broke");
    stop();
    stop = instrumentHttp({
      ...deps,
      calls: {
        get: () => {
          throw broken;
        },
      } as unknown as CallFingerprints,
    });
    enterRequest();
    await expect(fetch("http://127.0.0.1:1/nowhere")).rejects.toThrow("fetch failed");
    expect(failures.splice(0)).toEqual([broken]);
  });

  it("records no operation where nobody handed it a cache, as before", async () => {
    stop();
    stop = instrumentHttp(deps);
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/a`);
    expect((await workOf(ctx))[0]?.calls).toBe(1);
    expect(ctx.operations).toBeUndefined();
  });
});
