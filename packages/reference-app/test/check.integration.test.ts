import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `downtrace check` on the reference app: the regression the product is shown with (`n_plus_one`), a real
 * Postgres and a real Redis, and the real command run the way a developer runs it — base and working tree, the
 * same tests on both (LOC-01, ESC-17, ESC-18).
 *
 * The change has `n_plus_one` on and the base has it off, which is what a commit that introduced it looks like
 * to someone who has not committed yet. «checkout makes 4 queries per line instead of 3 for the whole order»: the
 * four queries are operations the base never ran, twelve times each per request, and the provider and Redis are
 * what they were.
 */
// covers: LOC-01, ESC-17, ESC-18

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

if (!DATABASE_URL) {
  if (process.env.DOWNTRACE_REQUIRE_DB && process.env.GITHUB_ACTIONS) {
    throw new Error(
      "DATABASE_URL is not set, and in CI a test that cannot run is a failure: this job would have passed without " +
        "running its integration tests",
    );
  }
  console.warn("[reference-app] DATABASE_URL not set: skipping the check integration test");
}

vi.setConfig({ testTimeout: 120_000 });

const run = promisify(execFile);
const APP_INDEX = new URL("../src/index.ts", import.meta.url).href;
const APP_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
/** The `downtrace` command of the agent package beside this one, the file its `bin` points at. */
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.resolve("@downtrace/agent/register")));

/** What a project's own test is: the reference app, started on ports the system picks, with traffic driven at it. */
const TEST = `
import { readFile } from "node:fs/promises";
import { createReferenceApp } from "${APP_INDEX}";

const regressions = (await readFile(new URL("./regressions.txt", import.meta.url), "utf8")).trim();
const ref = createReferenceApp({
  port: 0,
  providerPort: 0,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  appVersion: "check",
  regressions,
});
const { port } = await ref.start();
const base = "http://127.0.0.1:" + port;
await fetch(base + "/__admin/db/reset", { method: "POST" });

const cart = Array.from({ length: 12 }, (_, i) => ({ productId: i + 1, quantity: 1 }));
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(base + "/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: 1, items: cart }),
  });
  if (res.status !== 201) throw new Error("checkout answered " + res.status);
  await res.arrayBuffer();
}
for (let i = 0; i < 2; i += 1) await (await fetch(base + "/products")).arrayBuffer();
await ref.stop();
`;

const ROUTES = ["GET /products", "GET /products/:id", "GET /me", "POST /checkout"];

interface Report {
  status: string;
  summary: { worse: number; unchanged: number; notEvaluated: number } | null;
  routes: Array<{
    id: string;
    verdict: string;
    reasons: Array<{ code: string }>;
    requests: { base: number; change: number };
    operations: Array<{
      kind: string;
      hash: string | null;
      label: string | null;
      change: string;
      worse: boolean;
      perRequest: { base: number; change: number };
    }>;
    dependencies: Array<{ kind: string; worse: boolean; perRequest: { base: number; change: number } }>;
  }>;
  failure: { code: string; message: string } | null;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A repository whose base commit runs the tests with `base` on and whose working tree runs them with `change`. */
async function project(regressions: { base: string; change: string }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-check-reference-")));
  dirs.push(dir);
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=check", "-c", "user.email=check@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
    });
  await git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(dir, "app.mjs"), TEST);
  await writeFile(join(dir, ".gitignore"), "node_modules\n");
  await writeFile(join(dir, "regressions.txt"), `${regressions.base}\n`);
  await writeFile(join(dir, "downtrace.json"), JSON.stringify({ check: { command: "node app.mjs", routes: ROUTES } }));
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "base");
  // The application's dependencies, where `pg` is found from the test's own directory, as it is in a project.
  await symlink(APP_MODULES, join(dir, "node_modules"), "dir");
  await writeFile(join(dir, "regressions.txt"), `${regressions.change}\n`);
  return dir;
}

async function check(dir: string): Promise<{ code: number | null; report: Report; stderr: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("DOWNTRACE_")) env[name] = value;
  }
  env.DATABASE_URL = DATABASE_URL;
  env.REDIS_URL = REDIS_URL;
  const child = spawn(process.execPath, [CLI, "check", "--json", "--base", "HEAD"], { cwd: dir, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, report: JSON.parse(stdout) as Report, stderr };
}

const route = (report: Report, id: string) => {
  const found = report.routes.find((one) => one.id === id);
  if (!found) throw new Error(`no ${id} in ${report.routes.map((one) => one.id).join(", ")}`);
  return found;
};

describe.skipIf(!DATABASE_URL)("downtrace check on the reference app (integration)", () => {
  it("names POST /checkout as worse when n_plus_one is on in the change and off in the base", async () => {
    const { code, report, stderr } = await check(await project({ base: "", change: "n_plus_one" }));
    expect(report.status, `${stderr}\n${JSON.stringify(report.failure)}`).toBe("compared");
    expect(code).toBe(1);

    const checkout = route(report, "POST /checkout");
    expect(checkout.verdict).toBe("worse");
    expect(checkout.requests).toEqual({ base: 3, change: 3 });

    // «4 queries per line instead of 3 for the whole order»: three of the four are queries the base never ran, once
    // per line of a twelve-line cart; the fourth, the insert of the line, was one multi-row insert and is now twelve
    // — the same fingerprint, repeated.
    const appeared = checkout.operations.filter((operation) => operation.change === "appeared");
    expect(appeared.map((operation) => operation.kind)).toEqual(["query", "query", "query"]);
    for (const operation of appeared) {
      expect(operation.hash, operation.label ?? "").toMatch(/^[0-9a-f]+$/);
      expect(operation.perRequest).toEqual({ base: 0, change: 12 });
    }
    const labels = appeared.map((operation) => operation.label ?? "");
    expect(labels.some((label) => /SELECT id, price_cents FROM products WHERE id = \? FOR UPDATE/.test(label))).toBe(
      true,
    );
    const multiplied = checkout.operations.filter((operation) => operation.change === "multiplied");
    expect(multiplied).toHaveLength(1);
    expect(multiplied[0]?.label).toContain("INSERT INTO order_items");
    expect(multiplied[0]?.perRequest).toEqual({ base: 1, change: 12 });

    // The provider and Redis did not change: two calls and three commands per request, on both sides.
    const kinds = Object.fromEntries(checkout.dependencies.map((dependency) => [dependency.kind, dependency]));
    expect(kinds.call).toMatchObject({ worse: false, perRequest: { base: 2, change: 2 } });
    expect(kinds.command).toMatchObject({ worse: false, perRequest: { base: 3, change: 3 } });
    expect(kinds.query).toMatchObject({ worse: true, perRequest: { base: 12, change: 57 } });
  });

  it("lists the routes the tests do not call by name as not evaluated, and none of them as unchanged", async () => {
    const { report } = await check(await project({ base: "", change: "n_plus_one" }));
    for (const id of ["GET /me", "GET /products/:id"]) {
      expect(route(report, id)).toMatchObject({ verdict: "not-evaluated", reasons: [{ code: "not-called" }] });
    }
    // The one the tests do call, with nothing changed in it, is unchanged: the verdict is earned.
    expect(route(report, "GET /products")).toMatchObject({ verdict: "unchanged", requests: { base: 2, change: 2 } });
    const unchanged = report.routes.filter((one) => one.verdict === "unchanged").map((one) => one.id);
    expect(unchanged).not.toContain("GET /me");
    expect(unchanged).not.toContain("GET /products/:id");
  });

  // «Given the same code on both sides, when check runs ten times, then no route is ever worse.» One after the
  // other: they share a database, and each run resets it.
  it.each([
    ["with the regression on", "n_plus_one"],
    ["with it off", ""],
  ])("finds nothing worse when both sides run the same code, ten times, %s", async (_what, regressions) => {
    const dir = await project({ base: regressions, change: regressions });
    for (let time = 1; time <= 10; time += 1) {
      const { code, report, stderr } = await check(dir);
      expect(report.status, `run ${time}: ${stderr}`).toBe("compared");
      expect(
        report.routes.filter((one) => one.verdict === "worse"),
        `run ${time}`,
      ).toEqual([]);
      expect(route(report, "POST /checkout").verdict, `run ${time}`).toBe("unchanged");
      expect(code, `run ${time}`).toBe(0);
    }
  });
});
