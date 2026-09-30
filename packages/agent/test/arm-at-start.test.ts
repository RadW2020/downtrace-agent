import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * gh-903. The mount record used to arm at the load of `mounts.ts`, which every entry point imports: importing
 * the package — or loading `register` without a token — loaded express and wrapped `Router.prototype.use`
 * before the application could do anything, against the README's promise. The arming moved to `Agent.start()`:
 * these children are the proof the import alone does not pay it.
 *
 * They run in a child process, because what is asserted is the state of a fresh process's module cache and of
 * a prototype the test's own process may already have loaded; and they wait on the child's exit, never on a
 * timer.
 */
const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const probe = fileURLToPath(new URL("./support/express-untouched-probe.mjs", import.meta.url));

/** What the probe reports: the express and router modules in the cache before the application loaded them,
 * and whether the record's wrapper is on `Router.prototype.use` once it has. */
interface ProbeReport {
  loadedBeforeTheAppImportedAnything: string[];
  useWrapped: boolean;
}

/** The environment a child sees: the parent's, minus the agent's own variables, plus what the scenario sets.
 * `NODE_PATH` goes with them: the test runner puts the package store on it, and an application is never
 * started that way. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DOWNTRACE_TOKEN",
    "DOWNTRACE_URL",
    "DOWNTRACE_INSTRUMENT",
    "DOWNTRACE_INSPECT",
    "DOWNTRACE_DEBUG",
    "NODE_PATH",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function probeReport(stdout: string, where: string): ProbeReport {
  let report: unknown;
  try {
    report = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`${where}: the probe said no JSON\n${stdout}`);
  }
  return report as ProbeReport;
}

/** The assertions the import scenarios share: nothing of express in the cache, and the wrapper not in place. */
function expectUntouched(report: ProbeReport, where: string): void {
  expect(report.loadedBeforeTheAppImportedAnything, `${where}: express or router in the module cache`).toEqual([]);
  expect(report.useWrapped, `${where}: Router.prototype.use wrapped`).toBe(false);
}

describe("the mount record arms at start, not at the import (gh-903)", () => {
  it("register without a token loads no express and wraps no use", async () => {
    // Ten times in a row: the state checked is the one a fresh process has, and a load that raced in once in
    // a hundred would read as a pass here.
    for (let run = 0; run < 10; run += 1) {
      const where = `run ${run}`;
      const { code, stdout, stderr } = await runNode(["--import", register, probe], childEnv());
      expect(code, `${where}: the child failed to start\n${stderr}`).toBe(0);
      expect(stderr, `${where}: the disabled warning`).toMatch(/instrumentation disabled/);
      expectUntouched(probeReport(stdout, where), where);
    }
  }, 60_000);

  it("importing the package without starting it loads no express and wraps no use", async () => {
    for (let run = 0; run < 10; run += 1) {
      const where = `run ${run}`;
      const { code, stdout, stderr } = await runNode([probe, "import-index"], childEnv());
      expect(code, `${where}: the child failed to start\n${stderr}`).toBe(0);
      expectUntouched(probeReport(stdout, where), where);
    }
  }, 60_000);

  /**
   * The application a start whose arming fails: a plain HTTP server, in a directory from which express cannot
   * be resolved, under an agent that is configured to start. The agent's inspection mode writes the batch it
   * would send to the child's stderr, where this test reads it.
   */
  const ARMING_FAILURE_APP = `
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

let expressResolvable = true;
try {
  createRequire(import.meta.url).resolve("express");
} catch {
  expressResolvable = false;
}

const app = http.createServer((_req, res) => {
  res.end("ok");
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = \`http://127.0.0.1:\${app.address().port}\`;
await fetch(\`\${base}/healthz\`);
const { shutdown } = await import(pathToFileURL(process.argv[2]).href);
await shutdown();
app.closeAllConnections();
await new Promise((r) => app.close(r));
console.log(JSON.stringify({ expressResolvable }));
`;

  it("a start whose arming fails still starts, and the application is not broken", async () => {
    // express is unresolvable from a temp directory: the arming resolves it from the application's entry, and
    // this one has no node_modules above it. The child says so before the assertion trusts the failure.
    const dir = await mkdtemp(path.join(os.tmpdir(), "arm-at-start-"));
    try {
      const server = path.join(dir, "server.mjs");
      await writeFile(server, ARMING_FAILURE_APP, "utf8");
      const { code, stdout, stderr } = await runNode(
        ["--import", register, server, index],
        childEnv({ DOWNTRACE_INSPECT: "stderr" }),
      );
      expect(code, `the child failed to start\n${stderr}`).toBe(0);
      const report = JSON.parse(stdout.trim()) as { expressResolvable: boolean };
      expect(report.expressResolvable, "the failure is real: express is not resolvable from the child").toBe(false);
      // The agent started: the request the application served is in the batch it would have sent, named by
      // the heuristic — no express, so no template.
      const routes: string[] = [];
      for (const line of stderr.split("\n")) {
        if (!line.trimStart().startsWith("{")) continue;
        const batch = JSON.parse(line) as { intervals?: { endpoints?: { route?: unknown }[] }[] };
        for (const interval of batch.intervals ?? [])
          for (const endpoint of interval.endpoints ?? [])
            if (typeof endpoint.route === "string") routes.push(endpoint.route);
      }
      expect(routes, `the agent started and recorded the request\n${stderr}`).toContain("/healthz");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
