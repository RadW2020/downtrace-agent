import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apart, enterRequest, type RequestContext } from "../src/context.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { armNeon } from "../src/instrument/pg.ts";
import type { Logger } from "../src/log.ts";

/**
 * Neon's driver, `@neondatabase/serverless`: `pg` bundled into a file of its own, whose `Client` and `Pool` speak
 * Postgres's protocol over a WebSocket. What Drizzle's `neon-serverless`, `@vercel/postgres` and Prisma's
 * `@prisma/adapter-neon` query through. Its `neon()` queries over `fetch`, and is a call to a host as any other.
 */

const MARK = Symbol.for("downtrace.pg.instrumented");
const DATABASE_URL = process.env.DATABASE_URL;
/** The directory of the installed package, which exports neither its `package.json` nor anything but its two entries. */
const installed = path.dirname(createRequire(import.meta.url).resolve("@neondatabase/serverless"));

const handed: unknown[] = [];
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  expect(handed.splice(0), "the instrumentation failed").toEqual([]);
  while (cleanups.length) await cleanups.pop()?.();
});

/** An application whose own `node_modules` has Neon's driver, the installed one. */
async function application(): Promise<{ entry: string; require: NodeJS.Require }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "downtrace-neon-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "node_modules", "@neondatabase"), { recursive: true });
  await symlink(installed, path.join(dir, "node_modules", "@neondatabase", "serverless"), "dir");
  const entry = path.join(dir, "app.js");
  await writeFile(entry, "", "utf8");
  return { entry, require: createRequire(entry) };
}

function deps(said: string[] = []) {
  return {
    log: { warn: () => {}, debug: (line: string) => said.push(line) } satisfies Logger,
    internalError: (err: unknown) => handed.push(err),
    fingerprints: new FingerprintCache(100, "postgres"),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the driver's types are its own, and these tests read only its classes.
type Neon = any;

describe("Neon's driver", () => {
  it("is patched as pg's, on the CommonJS copy the application loaded, under the version its package says", async () => {
    const app = await application();
    const neon = app.require("@neondatabase/serverless") as Neon;
    const said: string[] = [];
    const armed = armNeon({ ...deps(said), from: app.entry });
    expect(armed.state).toBe("on");
    armed.attach();
    expect(neon.Client.prototype[MARK]).toBe(true);
    // Its package exports no `package.json`, which the version is read from all the same.
    expect(said).toContain("instrumented @neondatabase/serverless 1.2.0");
  });

  it("imports the ES module copy by its file from the first request, and patches it", async () => {
    const app = await application();
    const esm = (await import(pathToFileURL(path.join(installed, "index.mjs")).href)) as Neon;
    const armed = armNeon({ ...deps(), from: app.entry });
    armed.attach();
    await vi.waitFor(() => expect(esm.Client.prototype[MARK]).toBe(true));
  });
});

/**
 * A WebSocket made of a TCP socket, which is what Neon's proxy is to the driver: it sends Postgres's protocol through
 * it as it would through a socket, so this one reaches the test's own Postgres directly.
 */
class TcpWebSocket {
  binaryType = "arraybuffer";
  private readonly socket: net.Socket;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(url: string) {
    const { hostname, port } = new URL(url);
    this.socket = net.connect(Number(port), hostname);
    this.socket.on("connect", () => this.emit("open", {}));
    this.socket.on("data", (data) => this.emit("message", { data }));
    this.socket.on("close", () => this.emit("close", {}));
    this.socket.on("error", (error) => this.emit("error", error));
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: Uint8Array): void {
    this.socket.write(data);
  }
  close(): void {
    this.socket.end();
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe.skipIf(!DATABASE_URL)("Neon's driver against Postgres", () => {
  async function connected(): Promise<Neon> {
    const app = await application();
    const neon = app.require("@neondatabase/serverless") as Neon;
    neon.neonConfig.webSocketConstructor = TcpWebSocket;
    neon.neonConfig.wsProxy = (host: string, port: number) => `${host}:${port}`;
    neon.neonConfig.useSecureWebSocket = false;
    neon.neonConfig.pipelineConnect = false;
    armNeon({ ...deps(), from: app.entry }).attach();
    return neon;
  }

  async function inRequest(fn: () => Promise<unknown>): Promise<RequestContext> {
    return apart(async () => {
      const ctx = enterRequest();
      await fn();
      return ctx;
    });
  }

  it("counts its pool's queries as Postgres's, and a failed one as failed", async () => {
    const neon = await connected();
    const pool = new neon.Pool({ connectionString: DATABASE_URL });
    cleanups.push(() => pool.end());
    const ctx = await inRequest(async () => {
      await pool.query("select 1 as one");
      await pool.query("select * from downtrace_no_such_table").catch(() => {});
    });
    const work = [...(ctx.work?.entries() ?? [])].filter(([key]) => key.startsWith("postgres"));
    expect(work.map(([, w]) => [w.calls, w.errors])).toEqual([[2, 1]]);
    // By the server the connection string names, and with the wait for the pool's connections measured.
    const { hostname, port } = new URL(DATABASE_URL ?? "");
    expect(work.map(([, w]) => w.target)).toEqual([`${hostname}:${port}`]);
    expect(work[0]?.[1].waitMs).toBeGreaterThan(0);
    expect([...(ctx.operations?.values() ?? [])].map((o) => o.text)).toContain("select ? as one");
  });

  it("counts a client's query, connected by hand", async () => {
    const neon = await connected();
    const client = new neon.Client({ connectionString: DATABASE_URL });
    await client.connect();
    cleanups.push(() => client.end());
    const ctx = await inRequest(() => client.query("select 2 as two"));
    const work = [...(ctx.work?.entries() ?? [])].filter(([key]) => key.startsWith("postgres"));
    expect(work.map(([, w]) => w.calls)).toEqual([1]);
  });
});
