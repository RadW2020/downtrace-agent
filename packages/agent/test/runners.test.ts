import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * What a test run keeps of its profile, asked of the runners themselves (DT-79).
 *
 * The comparison before the deploy (LOC-01) compares the profiles of two runs of an application's tests. A run
 * lasts seconds and the profile's window a minute, so the profile is what the way out of each process hands over,
 * and the way out is the runner's: what it does with the processes or the threads it runs the tests in, and whether
 * it ends with an explicit exit. `process.exit()` waits for nothing and a terminated thread runs nothing, so what a
 * runner does at its end is a fact about the runner and not about the instrumentation, and the README states it per
 * runner (`What a test run keeps`). Every claim there names the test that asserts it, and these are those tests:
 * real runners, started the way a user starts them, over suites that call routes of their own in each of the
 * processes or threads, with the batches written to a file and read back.
 *
 * Vitest and `node:test` are the runners this repository has or ships; Jest and Mocha are checked by hand, and the
 * README says so in those words. Adding either to this package to have a test for the sentence would be a
 * dependency whose only use is to be run here.
 *
 * `packages/reference-app/test/runners.integration.test.ts` asks the same of the reference app, with a database.
 */

const agentDir = fileURLToPath(new URL("..", import.meta.url));
const suites = join(agentDir, "test/support/runners");
const vitestBin = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

/** What each suite visits that the other does not: the evidence that its process, or its thread, was heard. */
const FIRST = "GET /first-report";
const SECOND = "GET /second-report";

interface Batch {
  profile?: { endpoints: Array<{ method: string; route: string }> };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Starts a runner to its end, with the instrumentation loaded into **every** process it starts — which is what
 * `NODE_OPTIONS` does for processes and for threads — and the batches going to a file; returns the routes the
 * file's profiles hold. The runner's own output is the explanation of a failure, and so it is returned too.
 */
async function profiledBy(args: string[]): Promise<{ routes: Set<string>; code: number | null; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), "downtrace-runner-"));
  dirs.push(dir);
  const file = join(dir, "batches.jsonl");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("DOWNTRACE_") && !name.startsWith("VITEST") && name !== "NODE_OPTIONS") env[name] = value;
  }
  const child = spawn(process.execPath, args, {
    cwd: suites,
    env: {
      ...env,
      DOWNTRACE_INSPECT: file,
      DOWNTRACE_ENV: "test",
      NODE_OPTIONS: `--import ${agentDir}src/register.ts`,
    },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (c: Buffer) => {
      output += c.toString();
    });
  }
  const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  const routes = new Set<string>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line === "") continue;
      for (const e of (JSON.parse(line) as Batch).profile?.endpoints ?? []) routes.add(`${e.method} ${e.route}`);
    }
  }
  return { routes, code, output };
}

const vitest = (...flags: string[]): string[] => [vitestBin, "run", "--config", "vitest.config.mjs", ...flags];
const nodeTest = (...flags: string[]): string[] => [
  "--test",
  ...flags,
  join(suites, "first.node.mjs"),
  join(suites, "second.node.mjs"),
];

describe("what a test run keeps of its profile, by runner", () => {
  // The default of Vitest: a child process per test file, which the pool ends with a signal, and the
  // instrumentation's own handler hands over what the process holds before it dies of it.
  it("keeps the routes of every worker under vitest, in processes", async () => {
    const { routes, code, output } = await profiledBy(vitest());
    expect(code, output).toBe(0);
    expect([...routes], output).toEqual(expect.arrayContaining([FIRST, SECOND, "GET /products", "GET /me"]));
  }, 60_000);

  // The default of `node --test`: a process per test file, each ending on its own when its loop empties.
  it("keeps the routes of every worker under node:test", async () => {
    const { routes, code, output } = await profiledBy(nodeTest());
    expect(code, output).toBe(0);
    expect([...routes], output).toEqual(expect.arrayContaining([FIRST, SECOND, "GET /products", "GET /me"]));
  }, 60_000);

  // The runner that ends each of its processes with an explicit exit, without waiting: `--test-force-exit`, and
  // what `--exit` of Mocha and `--forceExit` of Jest do. The profile is written all the same, on the way out.
  it("keeps them when node:test ends every process with an explicit exit", async () => {
    const { routes, code, output } = await profiledBy(nodeTest("--test-force-exit"));
    expect(code, output).toBe(0);
    expect([...routes], output).toEqual(expect.arrayContaining([FIRST, SECOND, "GET /products", "GET /me"]));
  }, 60_000);

  // The limitation, pinned: Vitest ends the threads of its `threads` pool by terminating them, and a terminated
  // thread runs nothing — not `beforeExit`, not `exit`, not a signal handler. What it holds is gone, and no
  // instrumentation in the thread can write it. The README says so and says what to do instead. If a later change
  // makes this pass the other way, the sentence in the README is the one to change.
  it("loses the routes of the threads under vitest, which ends them by terminating them", async () => {
    const { routes, code, output } = await profiledBy(vitest("--pool=threads"));
    expect(code, output).toBe(0);
    expect([...routes], output).not.toContain(FIRST);
    expect([...routes], output).not.toContain(SECOND);
  }, 60_000);
});
