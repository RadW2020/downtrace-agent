import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../src/check/report.ts";
import { appFiles, cleanEnv, createProject, downtrace, type Project, snapshot } from "./support/check-project.ts";

/**
 * `downtrace check`, as a user runs it: the real command, in a real git repository, running a real application
 * twice — on the base commit and on the working tree — and saying what changed by composition (LOC-01).
 *
 * Real processes and a real repository, because what these tests are about is what happens around the comparison:
 * a worktree that is made and must be removed, a working tree that must not be touched, a process that must not
 * reach the network, and a run that fails in the ways a project's does.
 */
// covers: LOC-01, ESC-17, ESC-18

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const projects: Project[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.cleanup();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<Project> {
  const made = await createProject(files);
  projects.push(made);
  return made;
}

/** A directory of the test's own, for what `check` makes (TMPDIR) and for what the test keeps. */
async function room(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-check-room-")));
  scratch.push(dir);
  return dir;
}

interface Checked {
  code: number | null;
  report: CheckReport;
  stdout: string;
  stderr: string;
}

async function check(
  where: Project,
  args: string[],
  env: Record<string, string> = {},
  options: { cwd?: string } = {},
): Promise<Checked> {
  const { done } = downtrace(["check", "--json", ...args], { cwd: options.cwd ?? where.dir, env: cleanEnv(env) });
  const result = await done;
  return { ...result, report: JSON.parse(result.stdout) as CheckReport };
}

/** The worktrees the repository knows of: its own, and any a check left behind. */
async function worktrees(made: Project): Promise<string[]> {
  const listed = await made.git("worktree", "list", "--porcelain");
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** Whether a process is still running: a zombie nobody has reaped yet has stopped, whatever `kill` says. */
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const { stdout } = await promisify(execFile)("ps", ["-o", "stat=", "-p", String(pid)]).catch(() => ({ stdout: "Z" }));
  return !stdout.trim().startsWith("Z") && stdout.trim() !== "";
}

/** The pid a command wrote down once it started, waited for: a shell takes a moment to get as far as writing it. */
async function pidIn(file: string): Promise<number> {
  for (let tries = 0; tries < 100; tries += 1) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${file} was never written`);
}

const route = (report: CheckReport, id: string) => {
  const found = report.routes.find((one) => one.id === id);
  if (found === undefined) throw new Error(`the report has no ${id}: ${report.routes.map((one) => one.id).join(", ")}`);
  return found;
};

const REGRESSION = { perLine: true, newHost: true };

describe("a change that makes a route run more than it did (ESC-17)", () => {
  let checked: Checked;
  beforeAll(async () => {
    const regress = await createProject(appFiles({}));
    projects.push(regress);
    // The change is not committed: the working tree is what is compared with the base.
    await regress.write("regressions.json", JSON.stringify({ ...REGRESSION, reports: true }));
    checked = await check(regress, ["--base", "HEAD"]);
  });

  it("names the route as worse, and exits 1 for CI", () => {
    expect(checked.report.status).toBe("compared");
    expect(route(checked.report, "POST /checkout").verdict).toBe("worse");
    expect(checked.code).toBe(1);
  });

  it("names what appeared by its fingerprint and how many times a request ran it", () => {
    const appeared = route(checked.report, "POST /checkout").operations.find(
      (operation) => operation.change === "appeared",
    );
    expect(appeared).toMatchObject({
      kind: "call",
      label: "GET localhost (any port)",
      perRequest: { base: 0, change: 1 },
      executions: { base: 0, change: 3 },
      worse: true,
    });
  });

  it("says by how much an operation that was already there is repeated", () => {
    const multiplied = route(checked.report, "POST /checkout").operations.find(
      (operation) => operation.change === "multiplied",
    );
    expect(multiplied).toMatchObject({ kind: "call", perRequest: { base: 1, change: 12 } });
  });

  it("says how many requests each side saw of the route", () => {
    expect(route(checked.report, "POST /checkout")).toMatchObject({
      requests: { base: 3, change: 3 },
      profiledRequests: { base: 3, change: 3 },
    });
  });

  it("leaves what did not change as unchanged: the same code on a route beside it", () => {
    expect(route(checked.report, "GET /products").verdict).toBe("unchanged");
  });

  it("shows the durations of the two runs and judges neither", () => {
    const checkout = route(checked.report, "POST /checkout");
    expect(checkout.meanRequestMs.base).toBeGreaterThan(0);
    expect(checkout.meanRequestMs.change).toBeGreaterThan(0);
    expect(checked.report.notes.join("\n")).toContain("never judged");
  });

  it("keeps the progress of a run that takes minutes on stderr, so that stdout is the result alone", () => {
    expect(checked.stderr).toContain("downtrace: base: running node app.mjs");
    expect(() => JSON.parse(checked.stdout)).not.toThrow();
  });
});

describe("routes the tests do not exercise (ESC-18)", () => {
  let checked: Checked;
  beforeAll(async () => {
    const made = await createProject(appFiles({}));
    projects.push(made);
    await made.write("regressions.json", JSON.stringify({ reports: true }));
    checked = await check(made, ["--base", "HEAD"]);
  });

  it("lists a declared route nobody called, by name, as not evaluated", () => {
    expect(route(checked.report, "GET /orders")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "not-called" }],
    });
  });

  it("lists a route that only one run reached, and says which", () => {
    expect(route(checked.report, "GET /reports")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "not-called-in-base" }],
    });
  });

  it("lists a route whose requests ran nothing observable, which is what a simulated database looks like", () => {
    expect(route(checked.report, "GET /health")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "nothing-observed" }],
    });
  });

  it("never lists as unchanged a route it did not evaluate", () => {
    const unchanged = checked.report.routes.filter((one) => one.verdict === "unchanged").map((one) => one.id);
    expect(unchanged).toContain("GET /products");
    for (const id of ["GET /orders", "GET /reports", "GET /health"]) expect(unchanged).not.toContain(id);
    expect(checked.report.summary?.notEvaluated).toBeGreaterThanOrEqual(3);
  });
});

describe("the same code on both sides", () => {
  // «Given the same code on both sides, when check runs ten times, then no route is ever worse».
  it("is never worse, ten times in a row, and says it evaluated what it says is unchanged", async () => {
    const same = await project(appFiles({}));
    const runs: Checked[] = [];
    for (let batch = 0; batch < 2; batch += 1) {
      runs.push(...(await Promise.all(Array.from({ length: 5 }, () => check(same, ["--base", "HEAD"])))));
    }
    expect(runs).toHaveLength(10);
    for (const run of runs) {
      expect(run.report.status, run.stderr).toBe("compared");
      expect(run.report.routes.filter((one) => one.verdict === "worse")).toEqual([]);
      expect(run.code).toBe(0);
      expect(route(run.report, "GET /products").verdict).toBe("unchanged");
      expect(route(run.report, "POST /checkout").verdict).toBe("unchanged");
    }
  });
});

describe("two runs whose durations differ (LOC-01)", () => {
  it("get the same verdicts as two that do not: no verdict depends on a duration", async () => {
    const slow = await project(appFiles({}));
    await slow.write("regressions.json", JSON.stringify({ delayMs: 120 }));
    const checked = await check(slow, ["--base", "HEAD"]);
    const checkout = route(checked.report, "POST /checkout");
    // The change really is slower, by two orders of magnitude...
    expect(checkout.meanRequestMs.change ?? 0).toBeGreaterThan((checkout.meanRequestMs.base ?? 1) * 10);
    // ...and nothing is worse.
    expect(checked.report.routes.filter((one) => one.verdict === "worse")).toEqual([]);
    expect(checked.code).toBe(0);
  });
});

describe("what leaves the machine, and what is touched on it", () => {
  it("sends nothing: no run is given the token or the URL it was started with, and nothing connects out", async () => {
    const received: string[] = [];
    const sink = http.createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(202).end();
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const dir = await room();
    const connections = join(dir, "connections.txt");
    await writeFile(connections, "");
    try {
      const made = await project(appFiles({}));
      await made.write("regressions.json", JSON.stringify(REGRESSION));
      const tripwire = new URL("./support/network-tripwire.mjs", import.meta.url).href;
      const checked = await check(made, ["--base", "HEAD"], {
        // What a developer with production configured has in their shell: it must not reach the runs.
        DOWNTRACE_TOKEN: "dt_secret_token",
        DOWNTRACE_URL: `http://127.0.0.1:${(sink.address() as AddressInfo).port}`,
        NODE_OPTIONS: `--import=${tripwire}`,
        TRIPWIRE_FILE: connections,
      });
      expect(checked.report.status, checked.stderr).toBe("compared");
      expect(received).toEqual([]);
      const attempted = (await readFile(connections, "utf8")).split("\n").filter(Boolean);
      // The tripwire is live: it saw the application calling its provider, on this machine.
      expect(attempted.length).toBeGreaterThan(0);
      for (const target of attempted) expect(target, target).toMatch(/^(127\.0\.0\.1|localhost|::1|\[::1\]):\d+$/);
    } finally {
      await new Promise((resolve) => sink.close(resolve));
    }
  });

  it("leaves the working tree as it was: files, index, staged and unstaged changes, untracked and ignored files", async () => {
    const made = await project({ ...appFiles({}), ".gitignore": "node_modules/\nignored.log\n", "notes.txt": "one\n" });
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    await made.write("notes.txt", "one\ntwo\n");
    await made.git("add", "notes.txt");
    await made.write("notes.txt", "one\ntwo\nthree\n");
    await made.write("scratch.txt", "untracked\n");
    await made.write("ignored.log", "ignored\n");
    await made.write("node_modules/dep/index.js", "module.exports = 1;\n");
    await snapshot(made); // `git status` may refresh the index once; what is compared is after that
    const before = await snapshot(made);
    const tmp = await room();
    const checked = await check(made, ["--base", "HEAD"], { TMPDIR: tmp });
    expect(checked.report.status, checked.stderr).toBe("compared");
    expect(await snapshot(made)).toEqual(before);
    // The base was a worktree of its own and it is gone, from the repository's books and from the disk.
    expect(await worktrees(made)).toEqual([made.dir]);
    expect(await readdir(tmp)).toEqual([]);
    expect(await readdir(join(made.dir, ".git"))).not.toContain("worktrees");
  });

  it("does not let a package manager in the base rewrite the pnpm-workspace.yaml of the user", async () => {
    // What pnpm does when it runs: it looks upward for the nearest pnpm-workspace.yaml and rewrites it. The base
    // is checked out outside the repository, so what it finds going up is its own, never the user's.
    const rewrite = `
      import { readFile, writeFile } from "node:fs/promises";
      import { dirname, join } from "node:path";
      if (process.cwd() === process.env.PROJECT_DIR) process.exit(0);
      let dir = process.cwd();
      for (;;) {
        const path = join(dir, "pnpm-workspace.yaml");
        try {
          await writeFile(path, (await readFile(path, "utf8")) + "# rewritten\\n");
          console.log("rewrote " + path);
          break;
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
        if (dirname(dir) === dir) break;
        dir = dirname(dir);
      }
    `;
    // One project where the base has its own file, and one where only the working tree has it: the second is the
    // one a walk upward could reach the user's through.
    for (const tracked of [true, false]) {
      const made = await project({
        ...appFiles({}),
        "rewrite.mjs": rewrite,
        ...(tracked ? { "pnpm-workspace.yaml": "packages: []\n" } : {}),
      });
      await made.write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
      await made.write("regressions.json", JSON.stringify(REGRESSION));
      const before = await readFile(join(made.dir, "pnpm-workspace.yaml"), "utf8");
      const checked = await check(made, ["--base", "HEAD", "--", "sh", "-c", "node rewrite.mjs && node app.mjs"], {
        PROJECT_DIR: made.dir,
      });
      expect(checked.report.status, checked.stderr).toBe("compared");
      expect(await readFile(join(made.dir, "pnpm-workspace.yaml"), "utf8"), `tracked: ${tracked}`).toBe(before);
    }
  });

  it("refuses to make the base inside the repository: a walk upward from there would reach the user's files", async () => {
    const made = await project(appFiles({}));
    const inside = join(made.dir, "scratch");
    await mkdir(inside);
    const checked = await check(made, ["--base", "HEAD"], { TMPDIR: inside });
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "setup-failed", side: "base" });
    expect(checked.report.failure?.message).toContain("is inside the repository");
    expect(await readdir(inside)).toEqual([]);
  });
});

describe("the base of the project", () => {
  it("runs on the dependencies of the working tree, linked, and gives them back untouched", async () => {
    const files = appFiles({});
    const made = await project({
      ...files,
      "app.mjs": `import "fake-dep";\n${files["app.mjs"]}`,
      ".gitignore": "node_modules/\n",
    });
    await made.write(
      "node_modules/fake-dep/package.json",
      '{"name":"fake-dep","type":"module","exports":"./index.js"}',
    );
    await made.write("node_modules/fake-dep/index.js", "export default 1;\n");
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    const before = await snapshot(made);
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.status, checked.stderr + JSON.stringify(checked.report.failure)).toBe("compared");
    expect(await snapshot(made)).toEqual(before);
  });

  it("can be prepared, in the base and nowhere else, by what the configuration says", async () => {
    // Prepare turns the regression on in the base only: the base then does more than the working tree does, and
    // the working tree's own file is as it was.
    const made = await project({
      ...appFiles({}),
      "downtrace.json": JSON.stringify({
        check: {
          command: "node app.mjs",
          prepare: `test "$DOWNTRACE_CHECK_ORIGIN" != "$PWD" && echo '{"perLine":true}' > regressions.json`,
        },
      }),
    });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.status, checked.stderr).toBe("compared");
    const checkout = route(checked.report, "POST /checkout");
    expect(checkout.verdict).toBe("unchanged");
    expect(checkout.operations.find((operation) => operation.kind === "call")?.change).toBe("reduced");
    expect(await readFile(join(made.dir, "regressions.json"), "utf8")).toBe("{}");
  });

  it("says when the preparation fails, and that it is the base's setup", async () => {
    const made = await project({
      ...appFiles({}),
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs", prepare: "echo no >&2; exit 3" } }),
    });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "setup-failed", side: "base" });
    expect(checked.report.failure?.message).toContain("exited with 3");
    expect(checked.report.failure?.outputTail).toContain("no");
  });

  it("is a project inside a repository: the base runs in the same directory of its checkout", async () => {
    const inner = Object.fromEntries(
      Object.entries(appFiles({})).map(([path, text]) => [`services/api/${path}`, text]),
    );
    const made = await project(inner);
    await made.write("services/api/regressions.json", JSON.stringify(REGRESSION));
    const checked = await check(made, ["--base", "HEAD"], {}, { cwd: join(made.dir, "services", "api") });
    expect(checked.report.status, checked.stderr).toBe("compared");
    expect(route(checked.report, "POST /checkout").verdict).toBe("worse");
  });
});

describe("what goes wrong, said (COB-01)", () => {
  it("a base that does not run: the command fails on it, and that is said of the base, with its output", async () => {
    const made = await createProject({ ...appFiles({}), "app.mjs": "const = ;\n" });
    projects.push(made);
    await made.write("app.mjs", appFiles({})["app.mjs"] ?? "");
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.status).toBe("failed");
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "base" });
    expect(checked.report.failure?.outputTail).toContain("SyntaxError");
    expect(checked.report.routes).toEqual([]);
    // It stopped there: the change was not run on a base that did not.
    expect(checked.report.change).toBeNull();
  });

  it("a change that does not run: the command fails on it, and that is said of the change", async () => {
    const made = await project(appFiles({}));
    await made.write("app.mjs", "throw new Error('the change does not start');\n");
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "change" });
    expect(checked.report.failure?.outputTail).toContain("the change does not start");
    expect(checked.report.base?.exitCode).toBe(0);
  });

  it("a run that left no profile is said, with what happens and what to use, and is never unchanged", async () => {
    const made = await project(appFiles({}));
    // The instrumentation is not loaded in this run, which is what a runner that does not pass NODE_OPTIONS on is.
    const checked = await check(made, [
      "--base",
      "HEAD",
      "--",
      "env",
      "-u",
      "NODE_OPTIONS",
      "node",
      "app.mjs",
      "--test-force-exit",
    ]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({
      code: "no-profile",
      side: "base",
      message: "the run left no profile",
    });
    expect(checked.report.failure?.advice).toContain("This happens with node --test --test-force-exit");
    expect(checked.report.failure?.advice).toContain("drop --test-force-exit");
    expect(checked.report.summary).toBeNull();
    const text = (
      await downtrace(["check", "--base", "HEAD", "--", "env", "-u", "NODE_OPTIONS", "node", "app.mjs"], {
        cwd: made.dir,
      }).done
    ).stdout;
    expect(text).toContain("the run left no profile");
    expect(text).not.toMatch(/unchanged/i);
  });

  it("a run that ends the process without waiting is compared with a profile or said to have none, never unchanged on nothing", async () => {
    const made = await project({ ...appFiles({}), "app.mjs": `${appFiles({})["app.mjs"] ?? ""}\nprocess.exit(0);\n` });
    const checked = await check(made, ["--base", "HEAD"]);
    if (checked.report.status === "failed") {
      expect(checked.report.failure?.code).toMatch(/^(no-profile|nothing-evaluated)$/);
      return;
    }
    // A run that kept its profile is compared; one that kept part of it says which part is missing.
    for (const one of checked.report.routes.filter((r) => r.verdict !== "not-evaluated")) {
      expect(one.profiledRequests.base, one.id).toBeGreaterThan(0);
      expect(one.profiledRequests.change, one.id).toBeGreaterThan(0);
    }
  });

  it("a run in which no route could be evaluated says so, and names why for each", async () => {
    const made = await project(appFiles({ traffic: [["GET", "/health", 3]] }));
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "nothing-evaluated" });
    expect(route(checked.report, "GET /health").reasons[0]?.code).toBe("nothing-observed");
    expect(route(checked.report, "GET /orders").reasons[0]?.code).toBe("not-called");
  });

  it("a ref that does not exist", async () => {
    const made = await project(appFiles({}));
    const checked = await check(made, ["--base", "no-such-branch"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "bad-ref" });
    expect(checked.report.failure?.message).toContain("no-such-branch");
    expect(checked.report.failure?.advice).toContain("--base");
  });

  it("a ref that is an option", async () => {
    const made = await project(appFiles({}));
    const checked = await check(made, ["--base=--output=/tmp/x"]);
    expect(checked.report.failure).toMatchObject({ code: "bad-ref" });
  });

  it("a directory that is not a repository", async () => {
    const dir = await room();
    const { done } = downtrace(["check", "--json", "--", "node", "-e", "0"], { cwd: dir });
    const result = await done;
    const report = JSON.parse(result.stdout) as CheckReport;
    expect(result.code).toBe(2);
    expect(report.failure).toMatchObject({ code: "not-a-repository" });
  });

  it("no test command anywhere", async () => {
    const made = await project({ "readme.txt": "x" });
    const checked = await check(made, []);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "no-command" });
    expect(checked.report.failure?.advice).toContain("downtrace check -- npm test");
  });

  it("a configuration that cannot be read", async () => {
    const made = await project({ ...appFiles({}), "downtrace.json": '{"check":{"commmand":"x"}}' });
    const checked = await check(made, []);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "bad-config" });
    expect(checked.report.failure?.message).toContain("check.commmand");
  });

  it("a test command given on the command line takes the place of the configured one", async () => {
    const made = await project({ ...appFiles({}), "downtrace.json": '{"check":{"command":"exit 7"}}' });
    const checked = await check(made, ["--base", "HEAD", "--", "node", "app.mjs"]);
    expect(checked.report.status, checked.stderr).toBe("compared");
  });

  it("a run that does not end in time: stopped, with what it started, and said", async () => {
    const dir = await room();
    const pidFile = join(dir, "pid.txt");
    const made = await project(appFiles({}));
    const checked = await check(made, [
      "--base",
      "HEAD",
      "--timeout",
      "1",
      "--",
      "sh",
      "-c",
      `echo $$ > ${pidFile}; sleep 60`,
    ]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "timeout", side: "base" });
    expect(await alive(await pidIn(pidFile)), "the command is still running").toBe(false);
    expect(await worktrees(made)).toEqual([made.dir]);
  });

  it("a signal in the middle of a run: it stops what it started, takes the worktree away and says it was interrupted", async () => {
    const dir = await room();
    const pidFile = join(dir, "pid.txt");
    const tmp = await room();
    const made = await project(appFiles({}));
    let running: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });
    const { done, child } = downtrace(
      ["check", "--json", "--base", "HEAD", "--", "sh", "-c", `echo $$ > ${pidFile}; sleep 60`],
      {
        cwd: made.dir,
        env: cleanEnv({ TMPDIR: tmp }),
        onStderr: (text) => {
          if (text.includes("base: running")) running();
        },
      },
    );
    await started;
    const pid = await pidIn(pidFile);
    child.kill("SIGTERM");
    const result = await done;
    const report = JSON.parse(result.stdout) as CheckReport;
    expect(result.code).toBe(2);
    expect(report.failure).toMatchObject({ code: "interrupted" });
    expect(await alive(pid), "the command is still running").toBe(false);
    expect(await worktrees(made)).toEqual([made.dir]);
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("the exit status and the text, for CI and for a person", () => {
  it("exits 0 and says what was left out when nothing is worse", async () => {
    const made = await project(appFiles({}));
    const { done } = downtrace(["check", "--base", "HEAD"], { cwd: made.dir });
    const result = await done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("routes evaluated: 0 worse,");
    expect(result.stdout).toContain("Not evaluated (");
    expect(result.stdout).not.toContain("Worse (");
  });

  it("exits 1 and puts the route under Worse when one is", async () => {
    const made = await project(appFiles({}));
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    const result = await downtrace(["check", "--base", "HEAD"], { cwd: made.dir }).done;
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Worse (1)");
    expect(result.stdout).toMatch(/POST \/checkout/);
  });

  it("compares the working tree with a commit that is not HEAD", async () => {
    const made = await project(appFiles({}));
    const first = (await made.git("rev-parse", "HEAD")).trim();
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    await made.git("commit", "--quiet", "-am", "the regression");
    // The tree is clean and equal to HEAD: against HEAD nothing changed; against the first commit it did.
    const againstHead = await check(made, ["--base", "HEAD"]);
    const againstFirst = await check(made, ["--base", first]);
    expect(againstHead.report.summary?.worse).toBe(0);
    expect(againstFirst.report.summary?.worse).toBe(1);
    expect(againstFirst.report.base?.commit).toBe(first);
  });
});
