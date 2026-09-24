import { channel } from "node:diagnostics_channel";
import type { AddressInfo } from "node:net";
import { AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { remember, shutdown } from "../src/registered.ts";
import {
  captureException,
  expressErrorHandler,
  MAX_CONTEXT_KEY_LENGTH,
  MAX_CONTEXT_KEYS,
  MAX_CONTEXT_VALUE_LENGTH,
  sanitizeContext,
} from "../src/report.ts";
import { testConfig } from "./support/agent-config.ts";
import { escapedFrom } from "./support/escaped.ts";

/**
 * `product.md:372` (ERR-02): the application hands over an error it handled itself, with structural context,
 * sanitised, omitted in doubt, withheld in minimal mode and attributed to the request in progress when there
 * is one. And the exception a framework turns into a 5xx, which the priorities put with it.
 *
 * covers: ERR-02
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

const REQUEST_START = "http.server.request.start";
const RESPONSE_FINISH = "http.server.response.finish";

/** Every agent a test starts, stopped afterwards whatever the test did. */
const running: Agent[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await shutdown();
});

interface Sent {
  agent: Agent;
  /** The serialised body of the last batch, which is where invariant 5 is worth asking about. */
  body(): string;
  batch(): AggregatesBatch;
}

function start(over: Partial<AgentConfig> = {}, log: Logger = quiet): Sent {
  let body = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  const config: AgentConfig = testConfig("http://sink.invalid", {
    environment: "production",
    version: "v1",
    intervalMs: 60_000,
    instrument: new Set(["pg"]),
    ...over,
  });
  const agent = createAgent(config, { log, fetchImpl });
  agent.start();
  running.push(agent);
  return { agent, body: () => body, batch: () => JSON.parse(body) as AggregatesBatch };
}

/** One finished request, with whatever the application does inside it. */
function inRequest(url: string, what: () => void): void {
  const request = { method: "GET", url };
  channel(REQUEST_START).publish({ request });
  what();
  channel(RESPONSE_FINISH).publish({ request, response: { statusCode: 200 } });
}

/** Everything queued, with the profile's window closed, which is a short test's only chance to see it. */
async function flush(agent: Agent): Promise<void> {
  await agent.stop();
}

function operations(
  batch: AggregatesBatch,
  route: string,
): NonNullable<AggregatesBatch["profile"]>["endpoints"][0]["operations"] {
  const endpoint = batch.profile?.endpoints.find((e) => e.route === route);
  return endpoint?.operations ?? [];
}

/** What the process saw with no route, or nothing when the stop had nothing to send at all. */
function exceptionsSent(sent: Sent): NonNullable<AggregatesBatch["exceptions"]> {
  return sent.body() === "" ? [] : (sent.batch().exceptions ?? []);
}

/**
 * An error of the application's whose `property` runs a getter that throws what `thrown` makes. Reading it is
 * running the application's code, which is the whole of gh-664.
 */
function readingThrows(property: string, thrown: () => unknown): Error {
  const err = new Error("the application's error");
  Object.defineProperty(err, property, {
    get() {
      throw thrown();
    },
  });
  return err;
}

/** A `Proxy` whose target is gone: every operation on it throws, `instanceof` included. `typeof` does not. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable(new Error("the application's error"), {});
  revoke();
  return proxy;
}

/**
 * An error that writes down every time anything so much as looks at it. The handler is itself a proxy, so every
 * trap the engine asks for is recorded —`get`, `has`, `getPrototypeOf` for an `instanceof`, `ownKeys`— with no
 * list of traps somebody would have to keep complete: the names of the traps are the names of `Reflect`'s methods.
 */
function watched(touched: string[]): Error {
  const reflect = Reflect as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>;
  const traps = new Proxy({} as ProxyHandler<Error>, {
    get:
      (_handler, trap) =>
      (...args: unknown[]) => {
        touched.push(String(trap));
        return reflect[trap]?.(...args);
      },
  });
  return new Proxy(new Error("watched"), traps);
}

/**
 * What a route can hand the middleware, and whether reading it throws. Every row that throws does so from the
 * application's own code —a getter, a trap—, which is what the middleware used to run outside the guard: the
 * application's handler got our failure instead of its own error (gh-664). The rest are what Express passes on
 * whatever a route throws, a frozen object among them because nothing here may write to the application's error.
 */
type Handed = [what: string, make: () => unknown, throwsOnRead: boolean];
const handed: Handed[] = [
  ["an Error whose status getter throws", () => readingThrows("status", () => new Error("status getter broke")), true],
  [
    "an Error whose statusCode getter throws",
    () => readingThrows("statusCode", () => new Error("statusCode getter broke")),
    true,
  ],
  [
    "an Error whose status getter throws what cannot be described",
    () => readingThrows("status", () => Object.create(null)),
    true,
  ],
  [
    "a Proxy whose every read throws",
    () =>
      new Proxy(new Error("the application's error"), {
        get() {
          throw new Error("proxy get broke");
        },
      }),
    true,
  ],
  ["a revoked Proxy", revokedProxy, true],
  ["a frozen Error", () => Object.freeze(new Error("frozen")), false],
  ["a string", () => "just a string", false],
  ["a number", () => 42, false],
  ["null", () => null, false],
  ["undefined", () => undefined, false],
  ["a symbol", () => Symbol("thrown"), false],
];

describe("an error the application reports itself", () => {
  it("travels as an operation of the route it happened on", async () => {
    const sent = start();
    inRequest("/orders/7", () => sent.agent.report({ error: new Error("boom"), kind: "explicit" }));
    await flush(sent.agent);

    const ops = operations(sent.batch(), "/orders/:id");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe("explicit");
    expect(ops[0]?.text).toContain("Error: boom");
    expect(ops[0]?.count).toBe(1);
    // It failed, and it took no time: the application had already handled it by the time it said so.
    expect(ops[0]?.errors).toBe(1);
    expect(ops[0]?.totalMs).toBe(0);
  });

  it("travels as what the process saw when no request is being served", async () => {
    const sent = start();
    sent.agent.report({ error: new Error("outside"), kind: "explicit" });
    await flush(sent.agent);

    const batch = sent.batch();
    expect(batch.profile).toBeUndefined();
    expect(batch.exceptions).toHaveLength(1);
    expect(batch.exceptions?.[0]?.kind).toBe("explicit");
    expect(batch.exceptions?.[0]?.text).toContain("Error: outside");
  });

  it("groups repetitions under one signature and counts them", async () => {
    const sent = start();
    inRequest("/orders/7", () => {
      for (let i = 0; i < 3; i++) sent.agent.report({ error: new Error("boom"), kind: "explicit" });
    });
    await flush(sent.agent);

    const ops = operations(sent.batch(), "/orders/:id");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.count).toBe(3);
  });

  // The same throw seen twice — as the operation that failed and as the exception the framework turned into
  // a 5xx — is two facts with one identity text, so one hash. Keyed on the hash alone they merged into
  // whichever kind arrived first and one of the two disappeared into the other's count; the e2e caught it
  // with three errors where four had happened (gh-596).
  it("is a different operation from the same throw seen another way", async () => {
    const sent = start();
    const thrown = new Error("the same throw");
    inRequest("/orders/7", () => {
      sent.agent.report({ error: thrown, kind: "explicit" });
      sent.agent.report({ error: thrown, kind: "framework" });
    });
    await flush(sent.agent);

    const ops = operations(sent.batch(), "/orders/:id");
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.kind).sort()).toEqual(["explicit", "framework"]);
    expect(new Set(ops.map((o) => o.hash)).size, "they share one identity, as they should").toBe(1);
    for (const op of ops) expect(op.count).toBe(1);
  });

  it("still produces a batch the protocol accepts", async () => {
    const sent = start();
    inRequest("/orders/7", () =>
      sent.agent.report({ error: new Error("boom"), context: { stage: "authorize" }, kind: "explicit" }),
    );
    await flush(sent.agent);
    expect(validate(sent.batch()), ajv.errorsText(validate.errors)).toBe(true);
  });

  // The failure paths, which are the ones an application in trouble actually takes.
  it.each([
    ["a string", "just a string"],
    ["undefined", undefined],
    ["null", null],
    ["a plain object", { code: "E_NOPE" }],
    ["an object whose message is not a string", { message: 42 }],
    ["an array", [1, 2, 3]],
  ])("has an identity for %s, and does not throw", async (_what, thrown) => {
    const sent = start();
    expect(() => inRequest("/orders/7", () => sent.agent.report({ error: thrown, kind: "explicit" }))).not.toThrow();
    await flush(sent.agent);

    const ops = operations(sent.batch(), "/orders/:id");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.hash).toBeTruthy();
    expect(sent.agent.stats.internalErrors).toBe(0);
  });

  it("records nothing once the instrumentation has stopped", async () => {
    const sent = start();
    await sent.agent.stop();
    expect(() => sent.agent.report({ error: new Error("too late"), kind: "explicit" })).not.toThrow();
    // Nothing was queued, so the stop above sent what there was and nothing came after it.
    expect(sent.body()).not.toContain("too late");
  });

  // The exclusion is about endpoints, and this is the one configuration in which there is no endpoint to
  // match: told to observe nothing, the instrumentation opens no request context, so a report has no route to
  // be attributed to and travels as what the process saw. Pinned here because the README says it in words and
  // a sentence nothing checks is a comment (gh-596, ADR 0144).
  it("has no endpoint to exclude when it was told to observe nothing", async () => {
    const sent = start({ instrument: new Set(), excludeEndpoints: ["/internal/*"] });
    inRequest("/internal/sync", () => sent.agent.report({ error: new Error("reported anyway"), kind: "explicit" }));
    await flush(sent.agent);

    const batch = sent.batch();
    // The endpoint itself is excluded, as it always was: no aggregate, no route, no count.
    expect(sent.body()).not.toContain("/internal");
    expect(batch.intervals).toHaveLength(0);
    // And the report is there, with no route, because nothing knew which route it came from.
    expect(batch.exceptions?.[0]?.kind).toBe("explicit");
    expect(batch.exceptions?.[0]?.text).toContain("Error: reported anyway");
  });

  it("is not observed at all on an endpoint the operator excluded", async () => {
    const sent = start({ excludeEndpoints: ["/internal/*"] });
    inRequest("/internal/sync", () => sent.agent.report({ error: new Error("hidden"), kind: "explicit" }));
    // And something on a watched route, so there is a batch to look at at all.
    inRequest("/orders/7", () => sent.agent.report({ error: new Error("seen"), kind: "explicit" }));
    await flush(sent.agent);

    const body = sent.body();
    expect(body).not.toContain("hidden");
    expect(body).not.toContain("/internal");
    expect(body).toContain("seen");
  });
});

describe("the context it carries", () => {
  it("travels sanitised, with the key kept and the value gone", async () => {
    const sent = start();
    inRequest("/orders/7", () =>
      sent.agent.report({
        error: new Error("boom"),
        context: { stage: "authorize", retryable: true, orderId: 91823, who: "a@b.com" },
        kind: "explicit",
      }),
    );
    await flush(sent.agent);

    const context = operations(sent.batch(), "/orders/:id")[0]?.context;
    expect(context).toEqual({ stage: "authorize", retryable: "true", orderId: "?", who: "?" });
    // The value itself never reached the wire, which is the only place worth asking (invariant 5, IMP-01).
    expect(sent.body()).not.toContain("91823");
    expect(sent.body()).not.toContain("a@b.com");
  });

  it("keeps the first one seen for a signature and not the latest", async () => {
    const sent = start();
    inRequest("/orders/7", () => {
      sent.agent.report({ error: new Error("boom"), context: { stage: "first" }, kind: "explicit" });
      sent.agent.report({ error: new Error("boom"), context: { stage: "second" }, kind: "explicit" });
    });
    await flush(sent.agent);

    expect(operations(sent.batch(), "/orders/:id")[0]?.context).toEqual({ stage: "first" });
  });

  it("is withheld whole in minimal mode, and the identity survives", async () => {
    // The same thrown object for both, because a signature is about the place in the code and two `new
    // Error` on two lines are two errors — which is the point of ADR 0083 and was this test's first red.
    const thrown = new Error("boom");
    const plain = start();
    inRequest("/orders/7", () =>
      plain.agent.report({ error: thrown, context: { stage: "authorize" }, kind: "explicit" }),
    );
    await flush(plain.agent);
    const hash = operations(plain.batch(), "/orders/:id")[0]?.hash;

    const sent = start({ minimal: true });
    inRequest("/orders/7", () =>
      sent.agent.report({ error: thrown, context: { stage: "authorize" }, kind: "explicit" }),
    );
    await flush(sent.agent);

    const body = sent.body();
    expect(body).not.toContain("authorize");
    expect(body).not.toContain("stage");
    expect(body).not.toContain("boom");
    // The hash is a digest and says nothing, so it stays and the error still groups (ADR 0105).
    const withheld = sent.batch().profile?.endpoints[0]?.operations[0];
    expect(withheld?.context).toBeUndefined();
    expect(withheld?.hash).toBe(hash);
  });

  it("is not touched by DOWNTRACE_QUERY_TEXT=off, which is about queries", async () => {
    const sent = start({ queryText: false });
    inRequest("/orders/7", () =>
      sent.agent.report({ error: new Error("boom"), context: { stage: "authorize" }, kind: "explicit" }),
    );
    await flush(sent.agent);

    const op = operations(sent.batch(), "/orders/:id")[0];
    expect(op?.text, "the text follows the query switch").toBeUndefined();
    expect(op?.context).toEqual({ stage: "authorize" });
  });
});

/**
 * The sanitising on its own, where the bounds are easiest to state. Every one of these is a failure path: a
 * context is written by hand in somebody else's application and arrives as `unknown`.
 */
describe("what a context may be", () => {
  it.each([
    ["not an object", "stage=authorize"],
    ["an array", ["a", "b"]],
    ["null", null],
    ["absent", undefined],
    ["empty", {}],
  ])("is nothing at all when it is %s", (_what, given) => {
    expect(sanitizeContext(given)).toBeUndefined();
  });

  it("drops what is not a primitive, and keeps the rest", () => {
    expect(
      sanitizeContext({
        stage: "authorize",
        nested: { id: 1 },
        list: [1, 2],
        nothing: null,
        missing: undefined,
        fn: () => {},
      }),
    ).toEqual({ stage: "authorize" });
  });

  it("drops a key that is not a name", () => {
    expect(
      sanitizeContext({
        ok_key: "a",
        "not a key": "b",
        "9lives": "c",
        "": "d",
        ["x".repeat(MAX_CONTEXT_KEY_LENGTH + 1)]: "e",
      }),
    ).toEqual({ ok_key: "a" });
  });

  // Assembled at run time and never written whole: whole, it is shaped like a live Stripe key, and the push
  // protection of the public mirror, where everything under packages/ is published, refuses it (invariant 10,
  // gh-644, ADR 0155). The sanitiser is handed the very same string.
  const stripeShaped = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

  it("hands the sanitiser a token of the shape it stands for", () => {
    expect(stripeShaped).toMatch(/^sk_live_[0-9A-Za-z]{24}$/);
  });

  // The shape alone only ever looked at the first character, so a key carrying a value walked through it
  // whole — and the cloud does not re-sanitise what arrives. A key has to survive the sanitiser unchanged.
  it.each([
    ["an order id in the name", "order_12345"],
    ["a token in the name", stripeShaped],
    ["a version in the name", "api_v2"],
  ])("drops a key that is a value wearing a name: %s", (_what, key) => {
    expect(sanitizeContext({ [key]: "something" })).toBeUndefined();
  });

  it("keeps the names a developer actually writes", () => {
    const kept = sanitizeContext({ stage: "authorize", willRetry: true, cache_hit: false, "provider.name": "acme" });
    expect(Object.keys(kept ?? {})).toEqual(["stage", "willRetry", "cache_hit", "provider.name"]);
  });

  // The same omit-when-in-doubt rule an error message obeys (ADR 0084), which a value was not going through.
  it("omits a value of which too little survives, leaving the key and a `?`", () => {
    // Nothing but values and punctuation: what is left is residue, and the residue is what the rule omits.
    expect(sanitizeContext({ ref: "91823 / 4472" })).toEqual({ ref: "?" });
    // And what still reads as words keeps them, with the values already gone. This one is the reason the
    // threshold is counted in words and not in characters (ADR 0084): «ord-?» is still a shape somebody reads.
    expect(sanitizeContext({ ref: "ord-99 / inv-12" })).toEqual({ ref: "ord-? / inv-?" });
    expect(sanitizeContext({ note: "the provider refused twice" })).toEqual({ note: "the provider refused twice" });
  });

  // What the sanitiser cannot do, said in a test so the README's wording and the code agree: it replaces what
  // looks like a value and cannot recognise a plain word. Keeping identity out is the caller's job (IMP-01).
  it("cannot recognise a plain word, and the README says so", () => {
    expect(sanitizeContext({ customer: "alice" })).toEqual({ customer: "alice" });
  });

  it("keeps at most eight keys, in the order they were written", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`k${String.fromCharCode(97 + i)}`] = "v";
    const kept = sanitizeContext(many);
    expect(Object.keys(kept ?? {})).toHaveLength(MAX_CONTEXT_KEYS);
    expect(Object.keys(kept ?? {})[0]).toBe("ka");
  });

  it("truncates a value that is prose rather than a shape", () => {
    const long = "word ".repeat(40);
    expect(sanitizeContext({ note: long })?.note).toHaveLength(MAX_CONTEXT_VALUE_LENGTH);
  });

  it("omits a value of which nothing recognisable survived", () => {
    // Everything in it looks like a value, so what is left says nothing and is not worth risking (ADR 0084).
    expect(sanitizeContext({ token: "b7f3e1a29c4d5e6f7a8b9c0d1e2f3a4b" })).toEqual({ token: "?" });
    expect(sanitizeContext({ empty: "" })).toBeUndefined();
  });
});

/**
 * The exceptions a framework turns into a 5xx, against a real Express 5 application: the response has to be
 * the one the same application gives without the instrumentation, byte for byte (invariant 2).
 */
describe("the exception Express turns into a 5xx", () => {
  interface Running {
    url: string;
    close(): Promise<void>;
  }

  async function listen(build: (app: express.Express) => void): Promise<Running> {
    const app = express();
    build(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  /** The application's own handler, which answers and does not call `next`: the ordinary shape. */
  function ownHandler(app: express.Express): void {
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = (err as { status?: number }).status ?? 500;
      res.status(status).json({ error: "handled by the application" });
    });
  }

  it("records the error and changes nothing about the response", async () => {
    const sent = start();
    remember(sent.agent);
    const server = await listen((app) => {
      app.get("/boom", () => {
        throw new Error("the handler threw");
      });
      app.use(expressErrorHandler());
      ownHandler(app);
    });
    try {
      const res = await fetch(`${server.url}/boom`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "handled by the application" });
    } finally {
      await server.close();
    }
    await flush(sent.agent);

    const ops = operations(sent.batch(), "/boom");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe("framework");
    expect(ops[0]?.text).toContain("Error: the handler threw");
  });

  it("does the same for a handler that returns a rejected promise", async () => {
    const sent = start();
    remember(sent.agent);
    const server = await listen((app) => {
      app.get("/rejected", async () => {
        await Promise.resolve();
        throw new Error("the promise rejected");
      });
      app.use(expressErrorHandler());
      ownHandler(app);
    });
    try {
      expect((await fetch(`${server.url}/rejected`)).status).toBe(500);
    } finally {
      await server.close();
    }
    await flush(sent.agent);

    expect(operations(sent.batch(), "/rejected")[0]?.text).toContain("Error: the promise rejected");
  });

  it("passes on a declared client error without recording it", async () => {
    const sent = start();
    remember(sent.agent);
    const server = await listen((app) => {
      app.get("/missing", () => {
        throw Object.assign(new Error("no such thing"), { status: 404 });
      });
      app.use(expressErrorHandler());
      ownHandler(app);
    });
    try {
      expect((await fetch(`${server.url}/missing`)).status).toBe(404);
    } finally {
      await server.close();
    }
    await flush(sent.agent);

    expect(operations(sent.batch(), "/missing")).toHaveLength(0);
  });

  // The rule reads both names, and until gh-664 only `status` had a test: moving the rule is when the other
  // half is worth pinning.
  it("passes on a client error declared as statusCode without recording it", async () => {
    const sent = start();
    remember(sent.agent);
    const server = await listen((app) => {
      app.get("/missing", () => {
        throw Object.assign(new Error("no such thing"), { statusCode: 404 });
      });
      app.use(expressErrorHandler());
      ownHandler(app);
    });
    try {
      expect((await fetch(`${server.url}/missing`)).status).toBe(500);
    } finally {
      await server.close();
    }
    await flush(sent.agent);

    expect(operations(sent.batch(), "/missing")).toHaveLength(0);
    expect(sent.agent.stats.internalErrors).toBe(0);
  });

  it("records nothing when the application's own handler answers first", async () => {
    const sent = start();
    remember(sent.agent);
    const server = await listen((app) => {
      app.get("/boom", () => {
        throw new Error("nobody passed it on");
      });
      // The order the README warns about: a handler that answers and does not call `next` ends the chain.
      ownHandler(app);
      app.use(expressErrorHandler());
    });
    try {
      expect((await fetch(`${server.url}/boom`)).status).toBe(500);
    } finally {
      await server.close();
    }
    await flush(sent.agent);

    expect(sent.body()).not.toContain("nobody passed it on");
  });

  // With nothing of the application's after it, the error reaches `finalhandler`. The response has to be
  // Express's own default, byte for byte, because that is what «records and changes nothing» means when
  // there is nobody else left to answer (invariant 2).
  it("leaves Express's own default answer exactly as it is", async () => {
    // One throw site for both applications: Express's default page prints the stack, so a second `throw` on a
    // second line would make the two bodies differ by a line number and prove nothing. That was this test's
    // first red.
    const boom = (): never => {
      throw new Error("nobody after it");
    };
    const bare = await listen((app) => {
      app.get("/boom", boom);
    });
    let expectedStatus = 0;
    let expectedBody = "";
    try {
      const res = await fetch(`${bare.url}/boom`);
      expectedStatus = res.status;
      expectedBody = await res.text();
    } finally {
      await bare.close();
    }

    const sent = start();
    remember(sent.agent);
    const watched = await listen((app) => {
      app.get("/boom", boom);
      app.use(expressErrorHandler());
    });
    try {
      const res = await fetch(`${watched.url}/boom`);
      expect(res.status).toBe(expectedStatus);
      expect(await res.text()).toBe(expectedBody);
    } finally {
      await watched.close();
    }
    await flush(sent.agent);

    expect(operations(sent.batch(), "/boom")[0]?.kind).toBe("framework");
  });

  // A handler that answered and then threw. Express cannot change a response it has already sent, and neither
  // may this: what the client already received stays received, and the error is still recorded.
  it("records an error thrown after the headers were sent, and the client keeps its answer", async () => {
    const sent = start();
    remember(sent.agent);
    const server = await listen((app) => {
      app.get("/late", (_req, res) => {
        res.status(200).json({ ok: true });
        throw new Error("thrown after answering");
      });
      app.use(expressErrorHandler());
      ownHandler(app);
    });
    try {
      const res = await fetch(`${server.url}/late`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
    await flush(sent.agent);

    expect(operations(sent.batch(), "/late")[0]?.text).toContain("Error: thrown after answering");
  });

  it("does nothing at all with no instrumentation registered", async () => {
    await shutdown();
    const server = await listen((app) => {
      app.get("/boom", () => {
        throw new Error("no agent here");
      });
      app.use(expressErrorHandler());
      ownHandler(app);
    });
    try {
      const res = await fetch(`${server.url}/boom`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "handled by the application" });
    } finally {
      await server.close();
    }
  });

  /**
   * The ticket's probe (gh-664): a route throws the application's error, and the application's own handler,
   * after the middleware, answers whether what it received is the very object its route threw. Compared by
   * identity, which runs no getter and no trap, and against the same application without the middleware.
   */
  function throwing(thrown: unknown, { middleware }: { middleware: boolean }) {
    return (app: express.Express): void => {
      app.get("/boom", () => {
        throw thrown;
      });
      if (middleware) app.use(expressErrorHandler());
      app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).send(err === thrown ? "its own error" : "another error");
      });
    };
  }

  async function answered(build: (app: express.Express) => void): Promise<{ status: number; body: string }> {
    const server = await listen(build);
    try {
      const res = await fetch(`${server.url}/boom`);
      return { status: res.status, body: await res.text() };
    } finally {
      await server.close();
    }
  }

  const throwsOnRead = handed.filter(([, , throws]) => throws);

  it.each(throwsOnRead)("hands the application's handler its own error when it is %s", async (_what, make) => {
    const thrown = make();
    const bare = await answered(throwing(thrown, { middleware: false }));
    expect(bare, "without the middleware the application gets its own error").toEqual({
      status: 500,
      body: "its own error",
    });

    const sent = start();
    remember(sent.agent);
    const { value: seen, escaped } = await escapedFrom(() => answered(throwing(thrown, { middleware: true })));
    expect(seen).toEqual(bare);
    expect(escaped, "escaped as an uncaught exception").toEqual([]);
    // Reading it failed inside the instrumentation, and that is where it was counted (ADR 0161).
    expect(sent.agent.stats.internalErrors).toBe(1);
    expect(sent.agent.stats.disabled).toBe(false);
  });

  // Invariant 2 in full: the failure is counted, the tenth disables the instrumentation, and every request is
  // still answered by the application's own handler with the application's own error.
  it("counts ten unreadable errors, disables itself at the tenth, and the application never notices", async () => {
    const sent = start();
    remember(sent.agent);
    const thrown = readingThrows("status", () => new Error("status getter broke"));
    const server = await listen(throwing(thrown, { middleware: true }));
    try {
      const { value: bodies, escaped } = await escapedFrom(async () => {
        const out: string[] = [];
        for (let i = 0; i < 10; i++) out.push(await (await fetch(`${server.url}/boom`)).text());
        return out;
      });
      expect(bodies).toEqual(Array.from({ length: 10 }, () => "its own error"));
      expect(escaped, "escaped as an uncaught exception").toEqual([]);
      expect(sent.agent.stats.internalErrors).toBe(10);
      expect(sent.agent.stats.disabled).toBe(true);
      // Disabled reads nothing: the eleventh is answered the same way and costs no internal error.
      expect(await (await fetch(`${server.url}/boom`)).text()).toBe("its own error");
      expect(sent.agent.stats.internalErrors).toBe(10);
    } finally {
      await server.close();
    }
  });
});

/**
 * The middleware called the way Express calls it, with a `next` that keeps what it was given: whatever a route
 * threw, `next` gets that very value, once, and the instrumentation's reading of it stays inside the
 * instrumentation (invariant 2, gh-664). «The same» is identity, so a `Proxy` is compared without being read.
 */
describe("whatever the middleware is handed", () => {
  function handedOn(err: unknown): unknown[] {
    const passed: unknown[] = [];
    expressErrorHandler()(err, {}, {}, (e?: unknown) => {
      passed.push(e);
    });
    return passed;
  }

  it.each(handed)("%s reaches next as it is, and reading it stays inside", async (_what, make, throwsOnRead) => {
    const sent = start();
    remember(sent.agent);
    const err = make();
    const { value: passed, escaped } = await escapedFrom(async () => handedOn(err));
    expect(passed.length, "next is called once").toBe(1);
    expect(passed[0] === err, "next gets the application's own error").toBe(true);
    expect(escaped, "escaped as an uncaught exception").toEqual([]);
    expect(sent.agent.stats.internalErrors).toBe(throwsOnRead ? 1 : 0);
    expect(sent.agent.stats.disabled).toBe(false);

    await flush(sent.agent);
    // With no request being served it is what the process saw; an error that could not be read is not recorded.
    const framework = exceptionsSent(sent).filter((e) => e.kind === "framework");
    expect(framework).toHaveLength(throwsOnRead ? 0 : 1);
  });

  it.each(handed)("%s reaches next as it is with no instrumentation running", async (_what, make) => {
    await shutdown();
    const err = make();
    const { value: passed, escaped } = await escapedFrom(async () => handedOn(err));
    expect(passed.length, "next is called once").toBe(1);
    expect(passed[0] === err, "next gets the application's own error").toBe(true);
    expect(escaped, "escaped as an uncaught exception").toEqual([]);
  });

  // «With no instrumentation running it does nothing at all» is true only if nothing reads the error: reading it
  // is the application's code running, and that is what can throw.
  it("does not so much as look at the error with no instrumentation running", async () => {
    await shutdown();
    const touched: string[] = [];
    const err = watched(touched);
    const passed = handedOn(err);
    expect(touched).toEqual([]);
    expect(passed[0] === err).toBe(true);
  });

  // The control that makes the two around it mean something: with the instrumentation running the error is
  // read, so an empty list above is the middleware not looking, not the watch not seeing.
  it("does look at it with the instrumentation running", async () => {
    const sent = start();
    remember(sent.agent);
    const touched: string[] = [];
    handedOn(watched(touched));
    expect(touched).toContain("get");
  });

  // And the same once the instrumentation has stopped: a report to a dead agent costs one comparison.
  it("does not look at it once the instrumentation has stopped either", async () => {
    const sent = start();
    remember(sent.agent);
    await sent.agent.stop();
    const touched: string[] = [];
    const err = watched(touched);
    const passed = handedOn(err);
    expect(touched).toEqual([]);
    expect(passed[0] === err).toBe(true);
  });
});

describe("captureException, the call an application makes", () => {
  it("does nothing, and does not throw, with no instrumentation running", async () => {
    await shutdown();
    expect(() => captureException(new Error("nobody listening"), { stage: "boot" })).not.toThrow();
  });

  // An internal failure of the instrumentation is counted as one and stays inside: the application asked it
  // to record something, not to hand it a second error while it is already recovering from one (invariant 2).
  it("counts its own failure and does not propagate it", async () => {
    const sent = start();
    remember(sent.agent);
    const hostile = {};
    Object.defineProperty(hostile, "stage", {
      enumerable: true,
      get() {
        throw new Error("reading this context throws");
      },
    });

    expect(() => inRequest("/orders/7", () => captureException(new Error("handled"), hostile))).not.toThrow();
    expect(sent.agent.stats.internalErrors).toBe(1);
    expect(sent.agent.stats.disabled).toBe(false);
    await flush(sent.agent);
    // And nothing of that report was recorded: it failed before it had anything to record.
    expect(operations(sent.batch(), "/orders/:id")).toHaveLength(0);
  });

  /**
   * What reaches the guard's `catch` is whatever was thrown, and when a getter of the application's threw it,
   * it is the application's value. Describing it for the debug line is the one thing left that could throw from
   * inside the `catch`, and out of the guard: `String` on an object with no prototype, `instanceof` on a revoked
   * `Proxy`, a getter on `stack` (gh-664).
   */
  type Undescribable = [what: string, make: () => unknown];
  const undescribable: Undescribable[] = [
    ["an object with no prototype", () => Object.create(null)],
    ["a revoked Proxy", revokedProxy],
    ["an Error whose stack getter throws", () => readingThrows("stack", () => new Error("stack getter broke"))],
  ];

  it.each(undescribable)("counts a failure that is %s, logs it, and does not propagate it", async (_what, make) => {
    const lines: string[] = [];
    const sent = start({}, { warn: () => {}, debug: (line) => lines.push(line) });
    remember(sent.agent);
    const hostile = {};
    Object.defineProperty(hostile, "stage", {
      enumerable: true,
      get() {
        throw make();
      },
    });

    const { escaped } = await escapedFrom(async () => {
      expect(() => inRequest("/orders/7", () => captureException(new Error("handled"), hostile))).not.toThrow();
    });
    expect(escaped, "escaped as an uncaught exception").toEqual([]);
    expect(sent.agent.stats.internalErrors).toBe(1);
    expect(sent.agent.stats.disabled).toBe(false);
    // Counted and said, even when what was thrown cannot say anything about itself: in words, and not as an
    // empty line that reads like a log with nothing to say.
    expect(lines.filter((line) => line.startsWith("internal error: "))).toEqual([
      "internal error: (a thrown value that cannot be described)",
    ]);
  });

  // The README's promise for what the middleware passes on: «if you want one of those recorded,
  // `captureException` is the call». The client-error rule belongs to the framework's path and to nothing else.
  it.each(["status", "statusCode"])("records an error that declares a 404 as its %s", async (field) => {
    const sent = start();
    remember(sent.agent);
    inRequest("/orders/7", () => captureException(Object.assign(new Error("no such order"), { [field]: 404 })));
    await flush(sent.agent);

    const ops = operations(sent.batch(), "/orders/:id");
    expect(ops.map((o) => o.kind)).toEqual(["explicit"]);
    expect(ops[0]?.text).toContain("Error: no such order");
  });

  it("reaches the instrumentation the entry point remembered", async () => {
    const sent = start();
    remember(sent.agent);
    inRequest("/orders/7", () => captureException(new Error("handled"), { stage: "authorize" }));
    await flush(sent.agent);

    const ops = operations(sent.batch(), "/orders/:id");
    expect(ops[0]?.kind).toBe("explicit");
    expect(ops[0]?.context).toEqual({ stage: "authorize" });
  });
});
