import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTree, type Tree, type TreeOptions } from "./support/prisma-layouts.ts";

/**
 * Prisma 7 as an application starts it (DT-92): `node --import @downtrace/agent/register`, an ESM application that
 * imports `@prisma/adapter-pg` and nothing else of Postgres, and the adapter's own `pg`. The production path of the
 * observer — resolved from the application's entry without loading, patched from the first request after the load
 * (ADR 0209) — in a process of its own, which is the one thing the unit tests beside it cannot give: the entry is the
 * process's.
 *
 * What is run is the layouts of `test/support/prisma-layouts.ts`: real directories, with the real resolution, and
 * stand-ins for the two packages whose behaviour is not in question. That the real adapter goes through `pg` and the
 * real Prisma 7 calls the adapter in the request's own async context is what the lab measured, with Prisma 7.10.0
 * against a Postgres 17 (the README says what and how); here it is the part the instrumentation owns.
 */
const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));

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
 * The application: the adapter imported as Prisma 7's client imports it, and a route that runs two queries through
 * it, one with a value in it. With `own-pg` as the argument it also has a `pg` of its own, and a third query through it.
 */
const APP = `
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";

const require = createRequire(import.meta.url);
const adapter = new PrismaPg();
const own = process.argv[3] === "own-pg" ? new (require("pg").Client)() : undefined;

const app = http.createServer(async (req, res) => {
  await adapter.queryRaw("SELECT * FROM orders WHERE id = $1");
  await adapter.queryRaw("SELECT * FROM customers WHERE name = 'ana-zq'");
  if (own) await own.query("SELECT * FROM app_copy");
  res.end("ok");
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = \`http://127.0.0.1:\${app.address().port}\`;
for (let i = 0; i < 3; i++) await (await fetch(\`\${base}/orders\`)).arrayBuffer();
const { shutdown } = await import(pathToFileURL(process.argv[2]).href);
await shutdown();
app.closeAllConnections();
await new Promise((r) => app.close(r));
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

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.cleanup();
});

/** Starts the application in a tree of this layout under the instrumentation, and returns what it sent. */
async function startedIn(options: TreeOptions, argument: string): Promise<{ batches: Batch[]; stderr: string }> {
  const tree = await makeTree(options);
  trees.push(tree);
  const server = path.join(tree.dir, "server.mjs");
  await writeFile(server, APP, "utf8");
  const { code, stderr } = await run(
    ["--import", register, server, index, argument],
    childEnv({ DOWNTRACE_INSPECT: "stderr" }),
  );
  expect(code, `the child failed\n${stderr}`).toBe(0);
  const batches = batchesOf(stderr);
  expect(batches.length, `no batch left\n${stderr}`).toBeGreaterThan(0);
  return { batches, stderr };
}

const orders = (batches: Batch[]) =>
  batches
    .flatMap((b) => b.intervals)
    .flatMap((i) => i.endpoints)
    .find((e) => e.route === "/orders");
const operations = (batches: Batch[]) =>
  batches.find((b) => b.profile)?.profile?.endpoints.find((e) => e.route === "/orders")?.operations;

describe("the Prisma adapter's pg as an application starts", () => {
  it("is observed in a pnpm layout, where the application has no pg at its root", async () => {
    const { batches, stderr } = await startedIn({ adapter: "pnpm" }, "adapter-only");
    expect(
      orders(batches)?.dependencies?.map((d) => [d.kind, d.target]),
      stderr,
    ).toEqual([["postgres", "db.internal:5432"]]);
    // Three requests, two queries each, every one counted once.
    expect(orders(batches)?.dependencies?.[0]?.callsPerRequest, stderr).toEqual([0, 0, 3, 0, 0, 0, 0, 0]);
    expect(
      operations(batches)
        ?.map((o) => [o.kind, o.text, o.count])
        .sort(),
    ).toEqual(
      [
        ["query", "SELECT * FROM customers WHERE name = ?", 3],
        ["query", "SELECT * FROM orders WHERE id = ?", 3],
      ].sort(),
    );
    expect(batches[0]?.agent.observers, "the first batch says pg is watched").toMatchObject({ pg: "on" });
    // Invariant 5: the value in the second query is nowhere on the wire.
    expect(batches.map((b) => JSON.stringify(b)).join("\n")).not.toContain("ana-zq");
  }, 60_000);

  it("is observed beside the application's own pg, when the adapter's is another module", async () => {
    const { batches, stderr } = await startedIn(
      { app: "8.11.5", adapter: "nested", adapterVersion: "8.23.1" },
      "own-pg",
    );
    // Three queries a request, two through the adapter's copy and one through the application's, every one once.
    expect(orders(batches)?.dependencies?.[0]?.callsPerRequest, stderr).toEqual([0, 0, 0, 3, 0, 0, 0, 0]);
    expect(
      operations(batches)
        ?.map((o) => [o.kind, o.text, o.count])
        .sort(),
    ).toEqual(
      [
        ["query", "SELECT * FROM app_copy", 3],
        ["query", "SELECT * FROM customers WHERE name = ?", 3],
        ["query", "SELECT * FROM orders WHERE id = ?", 3],
      ].sort(),
    );
  }, 60_000);

  it("is not observed when the switch leaves pg out", async () => {
    const tree = await makeTree({ adapter: "pnpm" });
    trees.push(tree);
    const server = path.join(tree.dir, "server.mjs");
    await writeFile(server, APP, "utf8");
    const { code, stderr } = await run(
      ["--import", register, server, index, "adapter-only"],
      childEnv({ DOWNTRACE_INSPECT: "stderr", DOWNTRACE_INSTRUMENT: "http" }),
    );
    expect(code, `the child failed\n${stderr}`).toBe(0);
    const dependencies = batchesOf(stderr)
      .flatMap((b) => b.intervals)
      .flatMap((i) => i.endpoints)
      .flatMap((e) => e.dependencies ?? []);
    expect(dependencies.filter((d) => d.kind === "postgres")).toEqual([]);
  }, 60_000);
});
