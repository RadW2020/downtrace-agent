import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCommand, runEnv } from "../src/check/run.ts";

/**
 * What a run of the tests is given (LOC-01): an environment in which the instrumentation can only write a file, and
 * which reaches every process the runner starts.
 */
// covers: LOC-01

const REGISTER = "file:///opt/downtrace/dist/register.js";
const run = { registerUrl: REGISTER, inspectFile: "/tmp/dt/base.jsonl", side: "base" } as const;

/** Every `DOWNTRACE_` name the instrumentation reads, from its own source, not from a list kept beside it. */
async function readVariables(): Promise<string[]> {
  const source = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
  return [...new Set(source.match(/DOWNTRACE_[A-Z_]+/g) ?? [])];
}

describe("the environment of a run", () => {
  it("gives the instrumentation no token and no URL, and none of the settings of production", async () => {
    const variables = await readVariables();
    // The test reads the source, so a variable added tomorrow is in it tomorrow.
    expect(variables).toEqual(expect.arrayContaining(["DOWNTRACE_TOKEN", "DOWNTRACE_URL", "DOWNTRACE_MINIMAL"]));
    const parent = Object.fromEntries(variables.map((name) => [name, "x"]));
    const env = runEnv({ ...parent, PATH: "/usr/bin" }, run);
    const given = Object.keys(env).filter((name) => name.startsWith("DOWNTRACE_"));
    expect(given.sort()).toEqual(
      [
        "DOWNTRACE_ENV",
        "DOWNTRACE_INSPECT",
        "DOWNTRACE_INTERVAL_MS",
        "DOWNTRACE_PROFILE_MS",
        "DOWNTRACE_VERSION",
      ].sort(),
    );
    expect(env.DOWNTRACE_TOKEN).toBeUndefined();
    expect(env.DOWNTRACE_URL).toBeUndefined();
  });

  it("writes to the file of its side, and closes a window every second", () => {
    const env = runEnv({}, run);
    expect(env.DOWNTRACE_INSPECT).toBe("/tmp/dt/base.jsonl");
    expect(env.DOWNTRACE_INTERVAL_MS).toBe("1000");
    expect(env.DOWNTRACE_PROFILE_MS).toBe("1000");
  });

  it("loads the instrumentation through NODE_OPTIONS, which reaches every process and thread", () => {
    expect(runEnv({}, run).NODE_OPTIONS).toBe(`--import=${REGISTER}`);
  });

  it("keeps the NODE_OPTIONS the user already has, and adds to them", () => {
    expect(runEnv({ NODE_OPTIONS: "--max-old-space-size=4096" }, run).NODE_OPTIONS).toBe(
      `--max-old-space-size=4096 --import=${REGISTER}`,
    );
  });

  it("leaves the rest of the environment as it was", () => {
    const env = runEnv({ PATH: "/usr/bin", HOME: "/home/a", CI: "1" }, run);
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/a", CI: "1" });
  });

  it("keeps a package manager from installing on its own in the base, whose dependencies are the project's own", () => {
    expect(runEnv({}, run).npm_config_verify_deps_before_run).toBe("false");
    expect(runEnv({}, { ...run, side: "change" }).npm_config_verify_deps_before_run).toBeUndefined();
  });
});

describe("running a command", () => {
  const env = { PATH: process.env.PATH ?? "" };

  it("says how it ended and keeps the last of its output", async () => {
    const ran = await runCommand({
      command: "echo first; echo second >&2; exit 3",
      cwd: process.cwd(),
      env,
      timeoutMs: 20_000,
      signal: undefined,
    });
    expect(ran.exitCode).toBe(3);
    expect(ran.outputTail).toContain("first");
    expect(ran.outputTail).toContain("second");
    expect(ran.timedOut).toBe(false);
  });

  it("keeps only the end of a long output: a test run that prints a lot does not fill the memory", async () => {
    const ran = await runCommand({
      command: `node -e 'for (let i = 0; i < 20000; i += 1) console.log("line " + i)'`,
      cwd: process.cwd(),
      env,
      timeoutMs: 20_000,
      signal: undefined,
    });
    expect(ran.outputTail.length).toBeLessThanOrEqual(4000);
    expect(ran.outputTail).toContain("line 19999");
    expect(ran.outputTail).not.toContain("line 1\n");
  });

  it("is stopped when the signal says so, with what it started", async () => {
    const abort = new AbortController();
    const started = runCommand({
      command: "sleep 60",
      cwd: process.cwd(),
      env,
      timeoutMs: 120_000,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 200);
    const ran = await started;
    expect(ran.aborted).toBe(true);
    expect(ran.exitCode).not.toBe(0);
  });

  it("does not wait for something the command left running that still holds its output", async () => {
    const ran = await runCommand({
      command: "sleep 60 & echo done",
      cwd: process.cwd(),
      env,
      timeoutMs: 120_000,
      signal: undefined,
    });
    expect(ran.exitCode).toBe(0);
    expect(ran.outputTail).toContain("done");
  });

  it("says a command that cannot start, which is not a command that failed", async () => {
    await expect(
      runCommand({ command: "true", cwd: "/no/such/directory/anywhere", env, timeoutMs: 20_000, signal: undefined }),
    ).rejects.toThrow();
  });
});
