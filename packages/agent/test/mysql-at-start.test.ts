import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * MySQL as an application starts it (DT-91): `node --import @downtrace/agent/register`, a `mysql2` the
 * application loads from its own `node_modules`, and nothing else asked for. The production path of the
 * observer — resolved from the application's entry without loading it, patched from the first request at which
 * the application has loaded it (ADR 0209) — which the tests that hand the agent the module do not take.
 *
 * In a child process, because the entry is the process's own, and waited on its exit and never on a timer. The
 * agent's inspection mode writes each batch to the child's stderr, byte for byte, and this reads them there.
 */
const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const support = fileURLToPath(new URL("./support/mysql.ts", import.meta.url));

/** The environment a child sees: the parent's, minus the agent's own variables, and without `NODE_PATH`, which
 * the test runner fills with the package store and an application is never started with. */
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

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

/**
 * An application with a `mysql2` pool and a route that runs two queries, one with a double-quoted value. It
 * loads the driver at the top, as an application does, and serves three requests.
 */
const APP = `
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const mysql = require("mysql2");
const { startFakeMysql } = await import(pathToFileURL(process.argv[3]).href);
const database = await startFakeMysql();
const pool = mysql.createPool({
  host: database.host, port: database.port, user: "dt-user-zq", password: "hunter2-zq", database: "payroll-zq",
  connectionLimit: 1,
});

const app = http.createServer((req, res) => {
  pool.query("SELECT * FROM orders WHERE id = ?", [7], (err) => {
    if (err) { res.statusCode = 500; res.end("no"); return; }
    pool.query('SELECT * FROM customers WHERE name = "ana-zq"', () => res.end("ok"));
  });
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = \`http://127.0.0.1:\${app.address().port}\`;
for (let i = 0; i < 3; i++) await (await fetch(\`\${base}/orders\`)).arrayBuffer();
const { shutdown } = await import(pathToFileURL(process.argv[2]).href);
await shutdown();
app.closeAllConnections();
await new Promise((r) => app.close(r));
await new Promise((r) => pool.end(() => r()));
await database.close();
console.log(JSON.stringify({ target: database.host + ":" + database.port }));
`;

interface Batch {
  agent: { observers?: Record<string, string> };
  intervals: Array<{
    endpoints: Array<{
      route: string;
      dependencies?: Array<{ kind: string; target: string; callsPerRequest: number[]; errors: number }>;
    }>;
  }>;
  profile?: { endpoints: Array<{ route: string; operations: Array<{ kind: string; text?: string; count: number }> }> };
}

function batchesOf(stderr: string): Batch[] {
  const batches: Batch[] = [];
  for (const line of stderr.split("\n")) {
    if (line.trimStart().startsWith("{")) batches.push(JSON.parse(line) as Batch);
  }
  return batches;
}

describe("mysql2 as an application starts it", () => {
  it("is observed through `register`, with nothing asked for but the instrumentation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "downtrace-mysql-start-"));
    try {
      // The application's own `node_modules`: the driver, linked to the one this package has, so that the entry
      // resolves it from there and the module is the real one.
      const driver = path.dirname(createRequire(import.meta.url).resolve("mysql2/package.json"));
      await mkdir(path.join(dir, "node_modules"), { recursive: true });
      await symlink(driver, path.join(dir, "node_modules", "mysql2"), "dir");
      const server = path.join(dir, "server.mjs");
      await writeFile(server, APP, "utf8");

      const { code, stdout, stderr } = await run(
        ["--import", register, server, index, support],
        childEnv({ DOWNTRACE_INSPECT: "stderr" }),
      );
      expect(code, `the child failed\n${stderr}`).toBe(0);
      const { target } = JSON.parse(stdout.trim()) as { target: string };

      const batches = batchesOf(stderr);
      expect(batches.length, `no batch left\n${stderr}`).toBeGreaterThan(0);
      const orders = batches
        .flatMap((b) => b.intervals)
        .flatMap((i) => i.endpoints)
        .find((e) => e.route === "/orders");
      expect(orders, `the route was not recorded\n${stderr}`).toBeDefined();
      expect(orders?.dependencies?.map((d) => [d.kind, d.target])).toEqual([["mysql", target]]);
      // Three requests, two queries each.
      expect(orders?.dependencies?.[0]?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(3);

      const operations = batches
        .find((b) => b.profile)
        ?.profile?.endpoints.find((e) => e.route === "/orders")?.operations;
      expect(operations?.map((o) => [o.kind, o.text, o.count]).sort()).toEqual(
        [
          ["query", "SELECT * FROM customers WHERE name = ?", 3],
          ["query", "SELECT * FROM orders WHERE id = ?", 3],
        ].sort(),
      );

      // The first batch of the process says what it watches, and has no word for MySQL.
      expect(batches[0]?.agent.observers).toMatchObject({ pg: "unavailable", http: "on", redis: "on", runtime: "on" });
      expect(batches[0]?.agent.observers).not.toHaveProperty("mysql");

      const wire = batches.map((b) => JSON.stringify(b)).join("\n");
      for (const secret of ["dt-user-zq", "hunter2-zq", "payroll-zq", "ana-zq"]) {
        expect(wire, `leaked: ${secret}`).not.toContain(secret);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("is not observed when the switch leaves it out", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "downtrace-mysql-start-"));
    try {
      const driver = path.dirname(createRequire(import.meta.url).resolve("mysql2/package.json"));
      await mkdir(path.join(dir, "node_modules"), { recursive: true });
      await symlink(driver, path.join(dir, "node_modules", "mysql2"), "dir");
      const server = path.join(dir, "server.mjs");
      await writeFile(server, APP, "utf8");

      const { code, stderr } = await run(
        ["--import", register, server, index, support],
        childEnv({ DOWNTRACE_INSPECT: "stderr", DOWNTRACE_INSTRUMENT: "pg,http" }),
      );
      expect(code, `the child failed\n${stderr}`).toBe(0);
      const dependencies = batchesOf(stderr)
        .flatMap((b) => b.intervals)
        .flatMap((i) => i.endpoints)
        .flatMap((e) => e.dependencies ?? []);
      expect(dependencies.filter((d) => d.kind === "mysql")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
