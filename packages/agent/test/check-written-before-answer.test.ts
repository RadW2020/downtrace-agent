import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Under `downtrace check`, a process that has no other request in flight writes what it holds before its last
 * response leaves it (ADR 0248). A runner may end the application's server with SIGKILL as soon as that response is in —
 * Playwright's `webServer` does — and a write at the response's `finish`, after its bytes were on the socket, lost
 * the request one run in four.
 *
 * In a child process under `register`, as `check` starts one: the handler ends its response and reads the inspection
 * file in the same turn, before anything the response's sending schedules has run.
 */
const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));

const SERVER = `
import { readFileSync } from "node:fs";
import http from "node:http";

const file = process.env.DOWNTRACE_INSPECT;
const seen = [];
const server = http.createServer((req, res) => {
  res.end("ok");
  // How many of the process's writes have this route in them, as the response is ended: one more for each request.
  seen.push(readFileSync(file, "utf8").split("\\n").filter((line) => line.includes("/probe")).length);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
for (let i = 1; i <= 3; i += 1) await (await fetch(base + "/probe/" + i)).text();
server.close();
console.log(JSON.stringify(seen));
`;

describe("under check, the last response in flight", () => {
  it("is written before it leaves the process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "downtrace-written-before-"));
    try {
      const server = path.join(dir, "server.mjs");
      await writeFile(server, SERVER, "utf8");
      const inspect = path.join(dir, "batches.jsonl");
      await writeFile(inspect, "", "utf8");
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("DOWNTRACE_")) delete env[key];
      delete env.NODE_PATH;
      const child = spawn(process.execPath, ["--import", register, server], {
        env: { ...env, DOWNTRACE_INSPECT: inspect, DOWNTRACE_CHECK_ROUTES: path.join(dir, "routes.json") },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null"), stderr).toEqual([1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
