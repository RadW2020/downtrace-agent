import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * postgres.js as an application starts it (ADR 0235): `node --import @downtrace/agent/register`, a `postgres` the
 * application loads from its own `node_modules`, a real Postgres, and nothing else asked for. Both of the driver's
 * copies: the ESM one an `import` loads, which never enters the module cache, and the CommonJS one a `require`
 * loads, which does.
 *
 * In a child process, because the entry is the process's own, and waited on its exit and never on a timer. The
 * agent's inspection mode writes each batch to the child's stderr, and this reads them there.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DOWNTRACE_")) delete env[key];
  }
  delete env.NODE_PATH;
  return { ...env, PGJS_URL: DATABASE_URL ?? "", ...extra };
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
 * The application: two queries on `/orders` — one tagged with a value, one `sql.unsafe` with a literal in its
 * text — and a query on `/broken` that Postgres refuses. A query at start-up, outside any request. `$LOAD` is how
 * it loads the driver, and `$WARM` whether it waits, with requests that run no query, until its queries are made
 * of a class the instrumentation patched: the ESM copy is imported from the first request (ADR 0235).
 */
const APP = `
import http from "node:http";
import { pathToFileURL } from "node:url";
$LOAD
const sql = postgres(process.env.PGJS_URL, { max: 1, onnotice: () => {} });
await sql\`select 1 as started\`;

const app = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") { res.end("ok"); return; }
    if (req.url === "/orders") {
      const rows = await sql\`select * from (values (1, 'ana-zq')) as t(id, owner) where owner = \${"ana-zq"}\`;
      await sql.unsafe("select count(*) from (values (8), (9)) as t(id) where id > 7");
      res.end(String(rows.length));
      return;
    }
    if (req.url === "/broken") { await sql\`select * from no_such_table_zq\`; res.end(); return; }
    res.statusCode = 404; res.end();
  } catch { res.statusCode = 500; res.end("no"); }
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = \`http://127.0.0.1:\${app.address().port}\`;
const marked = () => Object.getPrototypeOf(sql\`select 1\`)[Symbol.for("downtrace.postgresjs.instrumented")] === true;
let warm = 0;
if ($WARM) {
  for (; warm < 200 && !marked(); warm++) await (await fetch(\`\${base}/health\`)).arrayBuffer();
}
const markedAtFirst = marked();
for (let i = 0; i < 3; i++) await (await fetch(\`\${base}/orders\`)).arrayBuffer();
const broken = (await fetch(\`\${base}/broken\`)).status;
const { shutdown } = await import(pathToFileURL(process.argv[2]).href);
await shutdown();
app.closeAllConnections();
await new Promise((r) => app.close(r));
await sql.end();
console.log(JSON.stringify({ marked: marked(), markedAtFirst, broken }));
`;

const ESM = 'import postgres from "postgres";';
const CJS =
  'import { createRequire } from "node:module";\nconst postgres = createRequire(import.meta.url)("postgres");';

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

/** Runs the application in a directory of its own, with the driver in its `node_modules`, and reads what it sent. */
async function application(load: string, options: { warm: boolean; env?: Record<string, string> }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "downtrace-postgresjs-"));
  try {
    const driver = path.resolve(path.dirname(createRequire(import.meta.url).resolve("postgres")), "..", "..");
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await symlink(driver, path.join(dir, "node_modules", "postgres"), "dir");
    const server = path.join(dir, "server.mjs");
    await writeFile(server, APP.replace("$LOAD", load).replace("$WARM", String(options.warm)), "utf8");
    const { code, stdout, stderr } = await run(
      ["--import", register, server, index],
      childEnv({ DOWNTRACE_INSPECT: "stderr", ...options.env }),
    );
    expect(code, `the child failed\n${stderr}`).toBe(0);
    const said = JSON.parse(stdout.trim()) as { marked: boolean; markedAtFirst: boolean; broken: number };
    const batches = batchesOf(stderr);
    expect(batches.length, `no batch left\n${stderr}`).toBeGreaterThan(0);
    const endpoint = (route: string) =>
      batches
        .flatMap((b) => b.intervals)
        .flatMap((i) => i.endpoints)
        .find((e) => e.route === route);
    const operations = (route: string) =>
      batches
        .find((b) => b.profile)
        ?.profile?.endpoints.find((e) => e.route === route)
        ?.operations.map((o) => [o.kind, o.text, o.count])
        .sort();
    return { said, batches, endpoint, operations, stderr, wire: batches.map((b) => JSON.stringify(b)).join("\n") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!DATABASE_URL)("postgres.js as an application starts it", () => {
  /** What every run below must have seen of `/orders` and `/broken`, once its queries are made of a patched class. */
  function observed(app: Awaited<ReturnType<typeof application>>) {
    expect(app.said.marked, "the application's Query was never patched").toBe(true);
    const orders = app.endpoint("/orders");
    expect(orders, `the route was not recorded\n${app.stderr}`).toBeDefined();
    // One dependency, with no server named: a postgres.js query does not know its connection.
    expect(orders?.dependencies?.map((d) => [d.kind, d.target])).toEqual([["postgres", ""]]);
    expect(orders?.dependencies?.[0]?.callsPerRequest.reduce((a, b) => a + b, 0)).toBe(3);
    expect(app.operations("/orders")).toEqual(
      [
        ["query", "select * from (values (?)) as t(id, owner) where owner = ?", 3],
        ["query", "select count(*) from (values (?)) as t(id) where id > ?", 3],
      ].sort(),
    );
    expect(app.said.broken).toBe(500);
    expect(app.endpoint("/broken")?.dependencies?.[0]).toMatchObject({ kind: "postgres", target: "", errors: 1 });
    // The query at start-up was nobody's request, and no route has it.
    expect(app.wire).not.toContain("started");
    expect(app.wire, "leaked a value").not.toContain("ana-zq");
    expect(app.batches[0]?.agent.observers).toMatchObject({ pg: "on" });
  }

  it("observes the ESM copy, from the request after the one that imported it", async () => {
    const app = await application(ESM, { warm: true });
    observed(app);
  }, 60_000);

  it("observes the CommonJS copy from the first request, as pg's", async () => {
    // Patched at the start of the first request, from the module cache, before its handler runs: the first of the
    // three `/orders` is counted, and nothing was waited for.
    const app = await application(CJS, { warm: false });
    expect(app.said.markedAtFirst).toBe(false);
    observed(app);
  }, 60_000);

  it("under `downtrace check`, observes the ESM copy from the first request", async () => {
    const routes = path.join(await mkdtemp(path.join(os.tmpdir(), "downtrace-postgresjs-routes-")), "routes.json");
    try {
      const app = await application(ESM, { warm: false, env: { DOWNTRACE_CHECK_ROUTES: routes } });
      expect(app.said.markedAtFirst).toBe(true);
      observed(app);
    } finally {
      await rm(path.dirname(routes), { recursive: true, force: true });
    }
  }, 60_000);

  it("is not observed when the switch leaves Postgres out", async () => {
    const app = await application(ESM, { warm: false, env: { DOWNTRACE_INSTRUMENT: "http" } });
    expect(app.said.marked).toBe(false);
    const dependencies = app.batches
      .flatMap((b) => b.intervals)
      .flatMap((i) => i.endpoints)
      .flatMap((e) => e.dependencies ?? []);
    expect(dependencies.filter((d) => d.kind === "postgres")).toEqual([]);
  }, 60_000);
});
