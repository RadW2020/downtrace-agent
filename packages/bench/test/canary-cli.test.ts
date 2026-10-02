import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The canary's own process, stopped the way a deployment stops it: SIGTERM in the middle of a cycle. The cycle has to
// end at its next wait, switch the regression off and answer the request it was serving, and the process has to exit,
// so a redeploy at night costs the night's verdict and not the reference app's state or a broken connection.

const cli = fileURLToPath(new URL("../src/canary-cli.ts", import.meta.url));
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("canary-cli", () => {
  it("answers the cycle it was in, switched off, when it is stopped mid-cycle, and exits", async () => {
    const switches: boolean[] = [];
    const app = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "PUT") {
          switches.push((JSON.parse(body) as { n_plus_one: { enabled: boolean } }).n_plus_one.enabled);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ n_plus_one: { enabled: switches.at(-1) ?? false, params: {} } }));
      });
    });
    const cloud = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url?.endsWith("/status") ? { freshness: { lastReceivedAt: new Date().toISOString() } } : { findings: [] },
        ),
      );
    });
    const port = await freePort();
    const child = spawn(process.execPath, [cli], {
      env: {
        PATH: process.env.PATH,
        CANARY_APP_URL: app,
        CANARY_CLOUD_URL: cloud,
        CANARY_PROJECT: "canary",
        CANARY_TOKEN: "dt_read",
        CANARY_PORT: String(port),
        CANARY_POLL_SECONDS: "60",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      await new Promise<void>((resolve) =>
        child.stdout.on("data", (d: Buffer) => d.includes("listening") && resolve()),
      );
      const answer = fetch(`http://127.0.0.1:${port}/cycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regression: "n_plus_one" }),
      });
      // Stopped while it waits for the finding, the first minute's wait barely begun.
      while (switches[0] !== true) await new Promise((r) => setTimeout(r, 20));
      child.kill("SIGTERM");

      const result = (await (await answer).json()) as { outcome: string; reason: string; switchedOff: boolean };
      expect(result.outcome).toBe("unmeasurable");
      expect(result.reason).toMatch(/stopped before the cycle ended \(SIGTERM\)/);
      expect(result.switchedOff).toBe(true);
      expect(switches).toEqual([true, false]);
      expect(await exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);
});
