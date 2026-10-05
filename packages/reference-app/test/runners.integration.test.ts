import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTES } from "./runners/tour.ts";

/**
 * A test run lasts seconds and the profile's window lasts a minute, so what a run keeps of its profile is what
 * the way out of the process hands over. The comparison before the deploy (LOC-01) reads exactly that, from the
 * file `DOWNTRACE_INSPECT` names, after the tests of an application have run under whatever runner it has.
 *
 * This starts the real runners — vitest and `node:test`, the two the reference app can be asked to run under —
 * over a suite that calls every route of the reference app once, with the instrumentation loaded the way a user
 * loads it, and reads what was written (DT-79). A runner that ends with an explicit exit, without waiting, is the
 * second case that matters: the profile is written all the same.
 *
 * `packages/agent/test/runners.test.ts` asks the same of a backend with no database, for the runners the
 * reference app cannot stand in for. This one is the application the product is measured on.
 */

const DATABASE_URL = process.env.DATABASE_URL;

// The same policy as `integration.test.ts`: skipping without a database is right on a development machine and
// wrong in CI, where a test that cannot run would go green by not running (gh-143).
if (!DATABASE_URL && process.env.DOWNTRACE_REQUIRE_DB && process.env.GITHUB_ACTIONS) {
  throw new Error(
    "DATABASE_URL is not set, and in CI a test that cannot run is a failure: this job would have passed without " +
      "running its integration tests",
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const vitestBin = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

interface Batch {
  ending?: string;
  profile?: { endpoints: Array<{ method: string; route: string; operations: Array<{ kind: string }> }> };
}

/** The environment a user's test run has, with nothing of this run's own instrumentation left in it. */
function environment(file: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("DOWNTRACE_") && name !== "NODE_OPTIONS") env[name] = value;
  }
  return {
    ...env,
    DOWNTRACE_INSPECT: file,
    DOWNTRACE_ENV: "test",
    // The way a user loads it for a run that starts more than one process: every one of them inherits it.
    NODE_OPTIONS: "--import @downtrace/agent/register",
  };
}

/** Runs one runner to its end and says how it ended; its output is the failure's explanation. */
function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, args, { cwd: packageDir, env });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (c: Buffer) => (output += c.toString()));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, output })));
}

/** Every batch the file holds, one JSON line each. */
function batchesIn(file: string): Batch[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Batch);
}

/** `METHOD route` to the kinds of operation the profile holds for it, across every process that wrote one. */
function profiled(batches: Batch[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const batch of batches) {
    for (const endpoint of batch.profile?.endpoints ?? []) {
      const key = `${endpoint.method} ${endpoint.route}`;
      const kinds = out.get(key) ?? new Set<string>();
      for (const operation of endpoint.operations) kinds.add(operation.kind);
      out.set(key, kinds);
    }
  }
  return out;
}

describe.skipIf(!DATABASE_URL)("the profile of a test run of the reference app", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function written(args: string[]): Promise<{ batches: Batch[]; code: number | null; output: string }> {
    const dir = await mkdtemp(join(tmpdir(), "downtrace-runner-"));
    dirs.push(dir);
    const file = join(dir, "batches.jsonl");
    const { code, output } = await run(args, environment(file));
    return { batches: batchesIn(file), code, output };
  }

  function expectEveryRoute(batches: Batch[], output: string): void {
    const routes = profiled(batches);
    for (const route of ROUTES) {
      expect(
        routes.has(route),
        `${route} is not in what was written: ${[...routes.keys()].join(", ")}\n${output}`,
      ).toBe(true);
      expect(routes.get(route)?.size, `${route} was profiled with nothing it ran`).toBeGreaterThan(0);
    }
    // The route that makes all three: what a comparison needs from it is each of them, not that it was called.
    expect([...(routes.get("POST /checkout") ?? [])].sort()).toEqual(["call", "command", "query"]);
  }

  it("holds every route the tests called, under vitest", async () => {
    const { batches, code, output } = await written([
      vitestBin,
      "run",
      "--config",
      "vitest.config.ts",
      "--root",
      "test/runners",
    ]);
    expect(code, output).toBe(0);
    expectEveryRoute(batches, output);
  }, 60_000);

  it("holds every route the tests called, under node:test", async () => {
    const { batches, code, output } = await written(["--test", "test/runners/tour.node.ts"]);
    expect(code, output).toBe(0);
    expectEveryRoute(batches, output);
  }, 60_000);

  // The runner that ends with an explicit exit, without waiting: the second case the profile must survive.
  it("holds them when the runner exits without waiting for anything", async () => {
    const { batches, code, output } = await written(["--test", "--test-force-exit", "test/runners/tour.node.ts"]);
    expect(code, output).toBe(0);
    expectEveryRoute(batches, output);
  }, 60_000);
});
