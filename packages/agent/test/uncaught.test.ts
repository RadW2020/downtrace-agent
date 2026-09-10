import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Invariant 2, asked of the thing it is hardest to ask it of.
 *
 * Watching for an uncaught exception is the one observation that can change what the application would
 * have done: `process.on("uncaughtException")` **handles** it, and a handled exception does not kill the
 * process. Measured before anything was written, with three processes throwing the same error:
 *
 * | variant                       | exit | stderr    |
 * | ----------------------------- | ---- | --------- |
 * | no listener                   | 1    | the trace |
 * | `on("uncaughtException")`     | 0    | nothing   |
 * | a listener that rethrows      | 7    | the trace |
 *
 * The plain listener is the worst thing that could happen: a process that had to die survives and exits
 * successfully, silently. So the instrumentation uses `uncaughtExceptionMonitor`, which Node calls before
 * the real handlers and which does not count as handling anything — and this is what proves it (gh-386).
 */

const agentDir = fileURLToPath(new URL("..", import.meta.url));

interface Ending {
  code: number | null;
  stderr: string;
}

/** Runs a throwing script, with the instrumentation loaded or not, and reports how it ended. */
async function ending(body: string, instrumented: boolean): Promise<Ending> {
  const args = instrumented ? ["--import", `${agentDir}src/register.ts`] : [];
  const child = spawn(process.execPath, [...args, "--input-type=module", "-e", body], {
    env: {
      ...process.env,
      // A sink that is not there: what this test measures is how the process ends, and a send that fails
      // must not be what changes it.
      DOWNTRACE_URL: "http://127.0.0.1:1",
      DOWNTRACE_TOKEN: "t",
      DOWNTRACE_INSTRUMENT: "none",
      DOWNTRACE_INTERVAL_MS: "60000",
    },
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
}

/** The instrumentation's own debug lines are not the application's output. */
function withoutOurs(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.startsWith("[downtrace]"))
    .join("\n");
}

const UNCAUGHT = `setTimeout(() => { throw new TypeError("boom in a timer"); }, 5);`;
const REJECTED = `Promise.reject(new RangeError("nobody caught me")); setTimeout(() => {}, 20);`;

describe("a process that dies", () => {
  it("dies the same way with the instrumentation loaded", async () => {
    const [bare, watched] = await Promise.all([ending(UNCAUGHT, false), ending(UNCAUGHT, true)]);
    expect(watched.code, "the exit code changed, which is invariant 2").toBe(bare.code);
    expect(bare.code).toBe(1);
    expect(withoutOurs(watched.stderr)).toBe(bare.stderr);
    expect(bare.stderr).toContain("TypeError");
  }, 30_000);

  it("dies the same way from a promise nobody caught", async () => {
    const [bare, watched] = await Promise.all([ending(REJECTED, false), ending(REJECTED, true)]);
    expect(watched.code, "the exit code changed, which is invariant 2").toBe(bare.code);
    expect(bare.code).toBe(1);
    expect(withoutOurs(watched.stderr)).toBe(bare.stderr);
    expect(bare.stderr).toContain("RangeError");
  }, 30_000);
});

/** Captures the batches that arrive, so a surviving process can be asked what it reported. */
async function sink(): Promise<{ url: string; batches: Record<string, unknown>[]; close: () => Promise<void> }> {
  const batches: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      try {
        batches.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // Not a batch; nothing to record.
      }
      res.writeHead(202, { "content-type": "application/json" }).end('{"accepted":1,"inserted":1}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("a process that survives what it threw", () => {
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()?.();
  });

  it("reports it, with its kind and its count", async () => {
    // The case where this is worth anything: an application with its own `uncaughtException` handler keeps
    // going, so there is a next batch. A process that dies loses it, and the README says so rather than
    // pretending otherwise.
    const s = await sink();
    servers.push(s.close);
    const script = `
      import { shutdown } from "${agentDir}src/registered.ts";
      process.on("uncaughtException", () => {});
      // From the same place twice, which is one signature that happened twice. Two throws on two lines
      // would be two signatures, and rightly so: the stack is what tells them apart.
      const boom = () => { throw new TypeError("boom in a timer"); };
      setTimeout(boom, 5);
      setTimeout(boom, 10);
      setTimeout(async () => { await shutdown(); process.exit(0); }, 60);
    `;
    const child = spawn(
      process.execPath,
      ["--import", `${agentDir}src/register.ts`, "--input-type=module", "-e", script],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          DOWNTRACE_URL: s.url,
          DOWNTRACE_TOKEN: "t",
          DOWNTRACE_INSTRUMENT: "none",
          DOWNTRACE_INTERVAL_MS: "60000",
        },
      },
    );
    await new Promise((r) => child.on("exit", r));

    const reported = s.batches.find((b) => b.exceptions !== undefined);
    expect(reported, `no batch carried an exception: ${JSON.stringify(s.batches)}`).toBeDefined();
    const all = reported?.exceptions as Array<{ kind: string; count: number; text?: string }>;
    expect(all).toHaveLength(1);
    // The same signature twice is one signature that happened twice, not two.
    expect(all[0]?.count).toBe(2);
    expect(all[0]?.kind).toBe("uncaught");
    expect(all[0]?.text).toContain("TypeError");
  }, 30_000);
});
