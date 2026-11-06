import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("register entry point", () => {
  it("without configuration: loads, warns once, changes no globals", async () => {
    const before = Object.keys(globalThis).sort();
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      delete process.env.DOWNTRACE_DSN;
      delete process.env.DOWNTRACE_TOKEN;
      delete process.env.DOWNTRACE_URL;
      await import("../src/register.ts");
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.filter((l) => l.includes("[downtrace]"))).toHaveLength(1);
    expect(lines[0]).toMatch(
      /instrumentation disabled: DOWNTRACE_DSN is not set, nor DOWNTRACE_TOKEN and DOWNTRACE_URL/,
    );
    expect(Object.keys(globalThis).sort()).toEqual(before);
  });
});

/**
 * DT-168. `register` started the instrumentation with nothing around the start, and a throw there ended the
 * application before it served: on Node 18.18, `diagnostics_channel.tracingChannel is not a function`, from
 * `attachHapi`. The floor keeps that one away now; any other would do the same. Here a supported Node is made to throw
 * at two points of the start: where that one threw, early, and at the start's last subscription, once nearly
 * everything is attached. `init()` starts the same instrumentation, and the same throw is tried through it.
 */
describe("a start that throws", () => {
  const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
  const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));

  /**
   * Preloads that make the child's start throw, each by refusing one channel of `node:diagnostics_channel` to whoever
   * asks for it. Node's own modules ask for others, and taking a function away whole would break them as well.
   */
  const THROWS = {
    // Where the throw DT-164 found came from: `attachHapi`, the first to ask for the modules required.
    early: `import dc from "node:diagnostics_channel";
const tracingChannel = dc.tracingChannel;
dc.tracingChannel = (name) => {
  if (name === "module.require") throw new Error("refused by the test");
  return tracingChannel(name);
};`,
    // The start's last subscriptions, to the requests the application serves.
    late: `import dc from "node:diagnostics_channel";
const subscribe = dc.subscribe;
dc.subscribe = (name, onMessage) => {
  if (name === "http.server.request.start") throw new Error("refused by the test");
  return subscribe(name, onMessage);
};`,
  } as const;
  const preload = (source: string): string[] => ["--import", `data:text/javascript,${encodeURIComponent(source)}`];

  /**
   * What the instrumentation listens to, one channel for each thing its start attaches that listens: the requests
   * the application serves, its outgoing calls by `node:http` and by `fetch`, Fastify's instances, the modules
   * required (Hapi, Jest and the drivers), and node-redis.
   */
  const CHANNELS = [
    "http.server.request.start",
    "http.server.response.finish",
    "http.client.request.start",
    "undici:request:create",
    "fastify.initialization",
    "tracing:module.require:end",
    "tracing:node-redis:command:start",
  ];
  const EVENTS = ["uncaughtExceptionMonitor", "beforeExit", "exit", "SIGINT", "SIGTERM"];

  /**
   * The application: it serves one request to itself, then prints what it served and what listens in it, and ends
   * on its own, as a process does once nothing is left to do. `start` runs first, before anything else of it.
   */
  const application = (start = ""): string => `${start}
const dc = await import("node:diagnostics_channel");
const http = await import("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const served = await new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port: server.address().port, path: "/users/1" }, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => resolve(res.statusCode + " " + body));
  }).on("error", reject);
});
server.close();
console.log(JSON.stringify({
  served,
  listening: ${JSON.stringify(CHANNELS)}.filter((name) => dc.hasSubscribers(name)),
  listeners: Object.fromEntries(${JSON.stringify(EVENTS)}.map((name) => [name, process.listenerCount(name)])),
  fetch: String(globalThis.fetch),
}));`;

  /** A sink that counts every request it gets, whatever it is: nothing at all may arrive. */
  let sink: http.Server;
  let received = 0;
  let url = "";
  beforeAll(async () => {
    sink = http.createServer((req, res) => {
      received++;
      req.resume();
      res.writeHead(202).end();
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => sink.close(resolve));
  });

  /** The parent's environment, minus the instrumentation's own variables and `NODE_OPTIONS`, plus `extra`. */
  function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("DOWNTRACE_") || key === "NODE_OPTIONS") delete env[key];
    return { ...env, ...extra };
  }

  function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, out, err }));
    });
  }

  const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

  /** How each entry starts the instrumentation, with a token and the sink's URL, in the application's process. */
  const ENTRIES = {
    register: { args: ["--import", register], start: "" },
    "init()": {
      args: [],
      start: `const { init } = await import(${JSON.stringify(index)});
init({ dsn: process.env.SINK_DSN });`,
    },
  } as const;

  for (const [entry, { args, start }] of Object.entries(ENTRIES)) {
    for (const where of ["early", "late"] as const) {
      it(`through ${entry}, ${where}: serves as without the instrumentation, says why once, and sends nothing`, async () => {
        received = 0;
        const without = await run([...preload(THROWS[where]), "--input-type=module", "-e", application()], childEnv());
        expect(without.code, without.err).toBe(0);
        expect(without.err).toBe("");

        const env = childEnv({
          DOWNTRACE_TOKEN: "dt_test",
          DOWNTRACE_URL: url,
          SINK_DSN: `http://dt_test@${url.slice(7)}`,
        });
        const withIt = await run(
          [...preload(THROWS[where]), ...args, "--input-type=module", "-e", application(start)],
          env,
        );
        expect(withIt.code, withIt.err).toBe(0);
        expect(JSON.parse(withIt.out)).toEqual(JSON.parse(without.out));
        expect(lines(withIt.err)).toEqual([expect.stringMatching(/^\[downtrace\] instrumentation disabled: /)]);
        expect(withIt.err).toContain("refused by the test");
        expect(received).toBe(0);
      });
    }
  }

  // What makes the comparison above worth reading: an instrumentation that started is seen by it, and sends.
  it("sees an instrumentation that started", async () => {
    received = 0;
    const without = await run(["--input-type=module", "-e", application()], childEnv());
    const env = childEnv({ DOWNTRACE_TOKEN: "dt_test", DOWNTRACE_URL: url });
    const withIt = await run(["--import", register, "--input-type=module", "-e", application()], env);
    expect(withIt.code, withIt.err).toBe(0);
    const seen = JSON.parse(withIt.out);
    const plain = JSON.parse(without.out);
    expect(seen.served).toBe(plain.served);
    expect(seen.listening).toEqual(CHANNELS);
    expect(seen.listeners).not.toEqual(plain.listeners);
    expect(seen.fetch).not.toBe(plain.fetch);
    expect(received).toBeGreaterThan(0);
  });
});
