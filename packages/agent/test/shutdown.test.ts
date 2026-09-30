import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `process.exit()` is immediate: it does not wait for a promise in flight and it does not fire `beforeExit`.
 * An application that calls it the moment its work is done cuts the instrumentation's last flush, and with
 * it the interval in hand, the profile's window and any capture evidence (gh-383).
 *
 * This is asked of **real processes**, because the whole failure is about a process ending: an in-process
 * test cannot exit and so cannot show it. The reference app lost this race in CI twice while passing every
 * time locally, which is the other reason to pin it here rather than trust a machine to be slow enough.
 */

/** What actually arrives: how many batches, and what each of them carries. */
async function sink(): Promise<{
  url: string;
  batches: number;
  bodies: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const state = { batches: 0 };
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      if (req.method === "POST") {
        state.batches += 1;
        try {
          bodies.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          // Not a body this side can read; the count still says it arrived.
        }
      }
      res.writeHead(202, { "content-type": "application/json" }).end('{"accepted":1,"inserted":1}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get batches() {
      return state.batches;
    },
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const agentDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Runs a real process the way a user runs one — `--import @downtrace/agent/register` — which records a
 * request and then leaves, waiting for the instrumentation or not.
 *
 * Through the entry point and not through `createAgent`, because the entry point is the thing under test:
 * it is what creates an agent the application never sees, and what has to leave it reachable.
 */
/** `wait` is what the process does before `process.exit()`: nothing, one awaited `shutdown()`, or a second one. */
async function leaving(
  url: string,
  wait: "none" | "await" | "again",
  env: Record<string, string> = {},
): Promise<number> {
  const script = `
    import { channel } from "node:diagnostics_channel";
    import { shutdown } from "${agentDir}src/registered.ts";
    const request = { method: "GET", url: "/orders" };
    channel("http.server.request.start").publish({ request });
    channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
    ${wait === "await" ? "await shutdown();" : wait === "again" ? "shutdown();\nawait shutdown();" : ""}
    process.exit(0);
  `;
  return leaves(script, url, env);
}

/** The same, with no request at all: the last interval is empty, and what leaves is the ending. */
async function leavingEmpty(url: string, env: Record<string, string> = {}): Promise<number> {
  const script = `
    import { shutdown } from "${agentDir}src/registered.ts";
    await shutdown();
    process.exit(0);
  `;
  return leaves(script, url, env);
}

/**
 * The production shape: a process that had already been sending, whose last interval is empty. It waits for
 * the interval's batch to land — on the instrumentation's own count of it, which is the event — and only then
 * leaves, so the interval the last flush closes has nothing in it.
 */
async function leavingAfterFirstBatch(url: string, env: Record<string, string> = {}): Promise<number> {
  const script = `
    import { channel } from "node:diagnostics_channel";
    import { registered, shutdown } from "${agentDir}src/registered.ts";
    const request = { method: "GET", url: "/orders" };
    channel("http.server.request.start").publish({ request });
    channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
    while ((registered()?.stats.sent ?? 0) < 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await shutdown();
    process.exit(0);
  `;
  return leaves(script, url, { DOWNTRACE_INTERVAL_MS: "1000", ...env });
}

/** Runs a real process the way a user runs one, and reports how it ended. */
function leaves(script: string, url: string, env: Record<string, string> = {}): Promise<number> {
  const child = spawn(
    process.execPath,
    ["--import", `${agentDir}src/register.ts`, "--input-type=module", "-e", script],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        DOWNTRACE_URL: url,
        DOWNTRACE_TOKEN: "t",
        DOWNTRACE_ENV: "test",
        DOWNTRACE_INSTRUMENT: "none",
        DOWNTRACE_INTERVAL_MS: "60000",
        ...env,
      },
    },
  );
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
}

describe("an application that leaves on its own", () => {
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()?.();
  });

  it("loses its last batch when it does not wait", async () => {
    // The failure, pinned. Not a warning about a race: the batch is simply not there.
    const s = await sink();
    servers.push(s.close);
    expect(await leaving(s.url, "none")).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.batches, "the batch arrived without anybody waiting for it").toBe(0);
  });

  it("keeps it when it waits", async () => {
    const s = await sink();
    servers.push(s.close);
    expect(await leaving(s.url, "await")).toBe(0);
    expect(s.batches).toBe(1);
    // The last batch says how the process is leaving: an application that awaited `shutdown()` is an `exit`
    // (gh-617, ADR 0148).
    expect(s.bodies[0]).toMatchObject({ ending: "exit" });
  });

  it("says exit even when the last interval had no traffic", async () => {
    // Nothing was recorded, so the last batch has no interval to carry: the ending alone is what leaves, and
    // it has to leave on its own, or a quiet process would read as one that stopped without saying (gh-617).
    const s = await sink();
    servers.push(s.close);
    expect(await leavingEmpty(s.url)).toBe(0);
    expect(s.batches).toBe(1);
    expect(s.bodies[0]).toMatchObject({ ending: "exit", intervals: [] });
  });

  it("says exit when it had already been sending and its last interval had no traffic", async () => {
    // The production shape: a process that sent its intervals for a while, and whose last one is empty. The
    // batches before it never carried an ending, and none of their landings may count as the ending said —
    // only the landing of a batch that carries it does, or this last batch would never go out (gh-617).
    const s = await sink();
    servers.push(s.close);
    expect(await leavingAfterFirstBatch(s.url)).toBe(0);
    expect(s.batches, "the interval's batch and the last one").toBe(2);
    expect(s.bodies[0]).not.toHaveProperty("ending");
    expect(s.bodies[1]).toMatchObject({ ending: "exit", intervals: [] });
  });

  it("a second shutdown() that leaves does not cut the first drain", async () => {
    // Two callers, the shape an application has: one asks for the hand-over without waiting —a signal's
    // handler, the self-disable after its tenth error— and the other awaits, and leaves when it resolves.
    // The second is the one `process.exit()` listens to, and a promise that resolves in the instant cuts
    // the first drain mid-batch: the last batch leaves with the process (gh-690).
    const s = await sink();
    servers.push(s.close);
    expect(await leaving(s.url, "again")).toBe(0);
    expect(s.batches).toBe(1);
  });

  it("does not mind when the instrumentation is not configured at all", async () => {
    // An application cannot depend on the telemetry being switched on, and waiting for something that was
    // never started must not be the thing that keeps it from exiting.
    const s = await sink();
    servers.push(s.close);
    expect(await leaving(s.url, "await", { DOWNTRACE_TOKEN: "", DOWNTRACE_URL: "" })).toBe(0);
    expect(s.batches).toBe(0);
  });
});
