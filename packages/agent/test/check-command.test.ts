import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliDeps, runCli } from "../src/check/command.ts";
import { readRun, readRunFile } from "../src/check/read.ts";
import type { CheckReport } from "../src/check/report.ts";
import { batch, endpoint, fileOf, interval, operation, profile, profileEndpoint } from "./support/check-batches.ts";
import { REGISTER_URL } from "./support/check-project.ts";

/**
 * `downtrace` as a function: what it prints where, and the status it ends with. A status of 1 means «a route got
 * worse» and nothing else, so whatever goes wrong — expected or not — must end in 2 (LOC-01).
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "downtrace-command-"));
  dirs.push(made);
  return made;
}

async function run(argv: string[], over: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv,
    env: { PATH: process.env.PATH },
    cwd: await dir(),
    tmpRoot: tmpdir(),
    registerUrl: REGISTER_URL,
    version: "9.9.9",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: undefined,
    ...over,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("the command", () => {
  it("prints the help on stdout and ends well", async () => {
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: downtrace check");
    expect(stderr).toBe("");
  });

  it("prints the version", async () => {
    expect(await run(["--version"])).toMatchObject({ code: 0, stdout: "9.9.9\n" });
  });

  it("says what is wrong with the arguments on stderr, and ends with 2", async () => {
    const { code, stdout, stderr } = await run(["check", "--frobnicate"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown option --frobnicate");
  });

  it("says there is no test command, as JSON when asked, and ends with 2", async () => {
    const { code, stdout } = await run(["check", "--json"]);
    expect(code).toBe(2);
    expect((JSON.parse(stdout) as CheckReport).failure).toMatchObject({ code: "no-command" });
  });

  it("says there is no test command in words, with what to do about it", async () => {
    const { stdout } = await run(["check"]);
    expect(stdout).toContain("no comparison could be made");
    expect(stdout).toContain("downtrace check -- npm test");
  });

  it("ends with 2, and not with the 1 of a route that got worse, when something nobody expected goes wrong", async () => {
    // A working directory that does not exist: nothing a check is prepared for, and everything that is its business.
    const { code, stdout } = await run(["check", "--json", "--", "node", "-e", "0"], {
      cwd: "/no/such/directory/anywhere",
    });
    expect(code).toBe(2);
    expect((JSON.parse(stdout) as CheckReport).failure?.code).toBe("setup-failed");
  });

  it("reads the configuration it is told to, and says when it cannot", async () => {
    const where = await dir();
    await writeFile(join(where, "elsewhere.json"), '{"check":{"commmand":"x"}}');
    const { code, stdout } = await run(["check", "--json", "--config", "elsewhere.json"], { cwd: where });
    expect(code).toBe(2);
    expect((JSON.parse(stdout) as CheckReport).failure).toMatchObject({ code: "bad-config" });
    const missing = await run(["check", "--json", "--config", "nowhere.json"], { cwd: where });
    expect((JSON.parse(missing.stdout) as CheckReport).failure?.code).toBe("bad-config");
  });
});

describe("reading a file as it is written", () => {
  it("is the same tally as reading its text", async () => {
    const text = fileOf(
      batch("a", {
        intervals: [interval(1000, 1000, [endpoint("GET", "/p", 4, { requestsWithCalls: 4 })])],
        profile: profile(1000, 1000, [profileEndpoint("GET", "/p", [operation("query", "q", "SELECT 1", 4)])]),
      }),
      batch("b", { intervals: [interval(1000, 1000, [endpoint("GET", "/p", 2)])] }),
    );
    const where = await dir();
    await writeFile(join(where, "run.jsonl"), `${text}\n`);
    expect(await readRunFile(join(where, "run.jsonl"))).toEqual(readRun(text));
  });

  it("is an empty run when nothing was written: a process that wrote nothing leaves no file", async () => {
    const tally = await readRunFile(join(await dir(), "never-written.jsonl"));
    expect(tally).toMatchObject({ batches: 0, processes: 0, requests: 0, malformed: 0 });
  });

  it("does not hold the file as one string: a line at a time, however many there are", async () => {
    const where = await dir();
    const one = fileOf(batch("a", { intervals: [interval(1000, 1000, [endpoint("GET", "/p", 1)])] }));
    // Distinct instants, so that none of them is the same interval written twice.
    const lines = Array.from({ length: 5000 }, (_, i) => one.replace('"start":1000', `"start":${1000 + i * 1000}`));
    await writeFile(join(where, "big.jsonl"), `${lines.join("\n")}\n`);
    const tally = await readRunFile(join(where, "big.jsonl"));
    expect(tally.requests).toBe(5000);
    expect(tally.malformed).toBe(0);
  });
});
