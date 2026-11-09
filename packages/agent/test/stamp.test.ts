import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { USAGE } from "../src/check/args.ts";
import { IMAGE_PREFIX, lookFurther, STAMP_FILE } from "../src/deployed.ts";
import { runStamp } from "../src/stamp.ts";
import { createProject, type Project } from "./support/check-project.ts";
import { readDocumentation } from "./support/documentation.ts";

/**
 * DT-223: `downtrace stamp` writes the commit a build is made from into the build, for the instrumentation to report
 * where no variable names the version and nobody can add one — an ECS task whose environment and start command belong
 * to another company. A real git repository and a real directory outside any, so that git's own answer is what is
 * tested.
 */

const SHA = "3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a";
const OTHER = "0123456789abcdef0123456789abcdef01234567";

const scratch: string[] = [];
const projects: Project[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  for (const project of projects) await project.cleanup();
});

/** A directory of its own, outside any repository: git is told not to look above it. */
async function bare(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-stamp-")));
  scratch.push(dir);
  return dir;
}

/** A build directory under git, with one commit; and that commit. */
async function checkout(): Promise<{ dir: string; head: string }> {
  const project = await createProject({ "package.json": '{"name":"api"}', "dist/main.js": "require('http');" });
  projects.push(project);
  return { dir: project.dir, head: (await project.git("rev-parse", "HEAD")).trim() };
}

/** The environment of a build step: a PATH to find git with, git kept inside `dir`, and `extra`. */
function buildEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: dirname(dir), ...extra };
}

async function stamp(dir: string, argv: string[] = [], env: NodeJS.ProcessEnv = buildEnv(dir)) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runStamp({
    argv,
    cwd: dir,
    env,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: new AbortController().signal,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

const stamped = (dir: string): Promise<string> => readFile(join(dir, STAMP_FILE), "utf8");

async function absent(file: string): Promise<boolean> {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

describe("downtrace stamp", () => {
  // covers: RF-122
  it("writes git's HEAD, where the build has the checkout", async () => {
    const { dir, head } = await checkout();
    const run = await stamp(dir);
    expect(run).toEqual({ code: 0, stdout: `wrote ${head} to ${join(dir, STAMP_FILE)}, from git\n`, stderr: "" });
    expect(await stamped(dir)).toBe(`${head}\n`);
  });

  // covers: RF-122
  it.each(["GITHUB_SHA", "CODEBUILD_RESOLVED_SOURCE_VERSION", "CI_COMMIT_SHA", "GIT_COMMIT", "BITBUCKET_COMMIT"])(
    "writes the commit %s names, where git cannot read the checkout",
    async (variable) => {
      const dir = await bare();
      const run = await stamp(dir, [], buildEnv(dir, { [variable]: SHA }));
      expect(run.code).toBe(0);
      expect(run.stdout).toBe(`wrote ${SHA} to ${join(dir, STAMP_FILE)}, from ${variable}\n`);
      expect(await stamped(dir)).toBe(`${SHA}\n`);
    },
  );

  // covers: RF-122
  it("passes over a variable that holds no commit: a version name, an S3 object's version, HEAD", async () => {
    const dir = await bare();
    const env = buildEnv(dir, {
      DOWNTRACE_VERSION: "v1.4.2",
      CODEBUILD_RESOLVED_SOURCE_VERSION: "3sL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY",
      BUILDKITE_COMMIT: "HEAD",
      GIT_COMMIT: SHA,
    });
    const run = await stamp(dir, [], env);
    expect(run.stdout).toBe(`wrote ${SHA} to ${join(dir, STAMP_FILE)}, from GIT_COMMIT\n`);
  });

  // covers: RF-122
  it("writes --commit before git and before any variable, in small letters", async () => {
    const { dir } = await checkout();
    const env = buildEnv(dir, { GITHUB_SHA: OTHER });
    const run = await stamp(dir, ["--commit", SHA.toUpperCase()], env);
    expect(run).toEqual({ code: 0, stdout: `wrote ${SHA} to ${join(dir, STAMP_FILE)}, from --commit\n`, stderr: "" });
    expect(await stamped(dir)).toBe(`${SHA}\n`);
    expect((await stamp(dir, [`--commit=${SHA.slice(0, 7)}`], env)).code).toBe(0);
    expect(await stamped(dir)).toBe(`${SHA.slice(0, 7)}\n`);
  });

  // covers: RF-122
  it("takes git before a CI's variable: the variable names what started the run, which a workflow may not check out", async () => {
    const { dir, head } = await checkout();
    const run = await stamp(dir, [], buildEnv(dir, { GITHUB_SHA: OTHER }));
    expect(run.stdout).toBe(`wrote ${head} to ${join(dir, STAMP_FILE)}, from git\n`);
  });

  // covers: RF-122
  it("ends with 1, says how to give a commit, and writes nothing, when there is no git and no variable", async () => {
    const dir = await bare();
    const run = await stamp(dir);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^downtrace stamp: no commit to write: git could not read one \(.+\)/);
    for (const hint of ["--commit <sha>", "GITHUB_SHA", "CODEBUILD_RESOLVED_SOURCE_VERSION", "Nothing was written."]) {
      expect(run.stderr).toContain(hint);
    }
    expect(await absent(join(dir, STAMP_FILE))).toBe(true);
  });

  // covers: RF-122
  it("ends with 1 when git is not there at all, and says so", async () => {
    const dir = await bare();
    const run = await stamp(dir, [], { GIT_CEILING_DIRECTORIES: dirname(dir), PATH: dir });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("git could not read one (git is not installed here)");
    expect(await absent(join(dir, STAMP_FILE))).toBe(true);
  });

  it.each([
    [["--commit", "v1.4.2"], '--commit wants a commit, 7 to 40 hexadecimal digits, not "v1.4.2"'],
    [["--commit"], "--commit needs a value"],
    [["--commit="], "--commit needs a value"],
    [["--frobnicate"], "unknown option --frobnicate for stamp"],
    [["dist"], 'unexpected "dist": stamp writes into the directory it runs in'],
  ])("ends with 2 and writes nothing for %j", async (argv, message) => {
    const dir = await bare();
    const run = await stamp(dir, argv, buildEnv(dir, { GITHUB_SHA: SHA }));
    expect(run.code).toBe(2);
    expect(run.stderr).toBe(`downtrace stamp: ${message}\n\n${USAGE}`);
    expect(await absent(join(dir, STAMP_FILE))).toBe(true);
  });

  it("ends with 2 when the file cannot be written, and says why", async () => {
    const dir = await bare();
    await mkdir(join(dir, STAMP_FILE));
    const run = await stamp(dir, ["--commit", SHA]);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe(`downtrace stamp: ${join(dir, STAMP_FILE)} could not be written (EISDIR)\n`);
  });

  it("prints its usage", async () => {
    const dir = await bare();
    expect(await stamp(dir, ["--help"])).toEqual({ code: 0, stdout: USAGE, stderr: "" });
    expect(USAGE).toContain("downtrace stamp [--commit <sha>]");
  });
});

describe("a build that ran downtrace stamp", () => {
  // covers: RF-122
  it("reports that commit at start-up, before the image's digest and before a fingerprint of its code", async () => {
    const { dir, head } = await checkout();
    expect((await stamp(dir)).code).toBe(0);
    const digest = `sha256:${"d6".repeat(32)}`;
    const ecs = (async () => new Response(JSON.stringify({ ImageID: digest }))) as unknown as typeof fetch;
    const look = (ecsMetadataUri: string | undefined) =>
      lookFurther({
        ecsMetadataUri,
        entry: join(dir, "dist/main.js"),
        fetchImpl: ecs,
        signal: new AbortController().signal,
        warn: (message) => {
          throw new Error(`no warning was expected: ${message}`);
        },
      });
    expect((await look("http://169.254.170.2/v4/x")).version).toBe(head);
    expect((await look(undefined)).version).toBe(head);
    await rm(join(dir, STAMP_FILE));
    expect((await look("http://169.254.170.2/v4/x")).version).toBe(`${IMAGE_PREFIX}${digest}`);
  });

  // covers: RF-122
  it("is a command of downtrace, as a user runs it", async () => {
    const dir = await bare();
    await writeFile(join(dir, "package.json"), '{"name":"api"}');
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "stamp", "--commit", SHA], {
        cwd: dir,
        env: buildEnv(dir),
        timeout: 30_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    expect(run).toEqual({ code: 0, stdout: `wrote ${SHA} to ${join(dir, STAMP_FILE)}, from --commit\n`, stderr: "" });
  });
});

describe("the documentation of downtrace stamp", () => {
  it("says where it goes in a Dockerfile and in a build script, where the file is read from, and its exit statuses", async () => {
    // covers: RF-122
    const docs = (await readDocumentation()).replaceAll("`", "").replace(/\s+/g, " ");
    const usage = USAGE.replace(/\s+/g, " ");
    const statuses = "Exit status of stamp: 0 written, 1 no commit was found and nothing was written, 2";
    expect(usage).toContain(statuses);
    expect(docs).toContain(statuses);
    for (const said of [
      "RUN npx downtrace stamp",
      '"build": "tsc && downtrace stamp"',
      ".dockerignore",
      "--build-arg",
      "the closest directory above your entry that has a package.json",
    ]) {
      expect(docs, said).toContain(said);
    }
  });
});
