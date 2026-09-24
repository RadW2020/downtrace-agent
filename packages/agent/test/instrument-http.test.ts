import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { currentContext, enterRequest, type RequestContext } from "../src/context.ts";
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
