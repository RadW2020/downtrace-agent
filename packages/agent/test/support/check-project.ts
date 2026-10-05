import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * A project to run `downtrace check` on: a real git repository in a directory of its own, with a base commit and
 * a working tree that differs from it, and a real command to run — what a user has, and not a stand-in for it.
 */

const run = promisify(execFile);

/** The command, as a user runs it: the file `bin` points at, run by Node. */
export const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** The instrumentation's own entry, as a URL: what a run preloads. */
export const REGISTER_URL = new URL("../../src/register.ts", import.meta.url).href;

export interface Project {
  dir: string;
  git(...args: string[]): Promise<string>;
  write(path: string, text: string): Promise<void>;
  cleanup(): Promise<void>;
}

/** What the environment of a test must not carry into the commands it runs: they must not reach a cloud. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("DOWNTRACE_") && name !== "NODE_OPTIONS") env[name] = value;
  }
  return { ...env, ...extra };
}

const IDENTITY = ["-c", "user.name=check", "-c", "user.email=check@example.com", "-c", "commit.gpgsign=false"];

/** A repository with `files` committed as its only commit. */
export async function createProject(files: Record<string, string>): Promise<Project> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-check-test-")));
  const git = async (...args: string[]): Promise<string> =>
    (await run("git", [...IDENTITY, ...args], { cwd: dir, env: cleanEnv() })).stdout;
  const project: Project = {
    dir,
    git,
    write: async (path, text) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  await git("init", "--quiet", "--initial-branch=main");
  for (const [path, text] of Object.entries(files)) await project.write(path, text);
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "base");
  return project;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `downtrace` as a process, the way a user does, and says what it printed and how it ended. */
export function downtrace(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; onStderr?: (text: string) => void },
): { done: Promise<CliResult>; child: ReturnType<typeof spawn> } {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    env: options.env ?? cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    options.onStderr?.(stderr);
  });
  const done = new Promise<CliResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { done, child };
}

/**
 * What a project's test is, here: an application that serves a few routes and calls a provider on this machine
 * — on a port it picks itself, as a test's stub does — drives its own traffic and ends the way an application
 * that was let alone ends, by having nothing left to do. `regressions.json` is what differs between the base and
 * the change: the same code, switched.
 *
 * The routes, and what each one does to the provider:
 *
 * - `GET /health` calls nothing.
 * - `GET /products` makes one call to the provider.
 * - `POST /checkout` makes one call to the provider; with `perLine` it makes twelve (the N+1), and with `newHost`
 *   it also calls a host it never called (an operation that appeared).
 * - `GET /reports` is reached only when `reports` is on.
 * - `GET /orders` is never reached.
 *
 * `delayMs` makes the provider slower, and `traffic` replaces what the application drives: a list of
 * `[method, path, times]`.
 */
export const APP = `
import http from "node:http";
import { readFile } from "node:fs/promises";

const regress = JSON.parse(await readFile(new URL("./regressions.json", import.meta.url), "utf8"));

const provider = http.createServer((req, res) => {
  req.resume();
  setTimeout(() => res.end("ok"), regress.delayMs ?? 0);
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = provider.address().port;

const agent = new http.Agent({ keepAlive: false });
function call(host, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: providerPort, method, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });
}

const app = http.createServer(async (req, res) => {
  req.resume();
  if (req.url === "/products") await call("127.0.0.1");
  if (req.url === "/checkout") {
    for (let i = 0; i < (regress.perLine ? 12 : 1); i += 1) await call("127.0.0.1", "POST");
    if (regress.newHost) await call("localhost");
  }
  if (req.url === "/reports") await call("127.0.0.1");
  res.end("ok");
});
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const appPort = app.address().port;

function hit(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: appPort, method, path, agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });
}

const traffic = regress.traffic ?? [["GET", "/health", 2], ["GET", "/products", 3], ["POST", "/checkout", 3]];
for (const [method, path, times] of traffic) {
  for (let i = 0; i < times; i += 1) await hit(method, path);
}
if (regress.reports) await hit("GET", "/reports");

app.close();
provider.close();
`;

export const DECLARED_ROUTES = ["GET /health", "GET /products", "POST /checkout", "GET /orders"];

/** The files of the project, with `regressions` as the base has them. */
export function appFiles(regressions: Record<string, unknown> = {}): Record<string, string> {
  return {
    "app.mjs": APP,
    "regressions.json": JSON.stringify(regressions),
    "downtrace.json": JSON.stringify({ check: { command: "node app.mjs", routes: DECLARED_ROUTES } }),
  };
}

/** Everything a person could tell had been touched in a working tree, and in the repository around it. */
export async function snapshot(project: Project): Promise<Record<string, unknown>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(project.dir, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path === ".git") continue;
      if (entry.isDirectory()) await walk(path);
      else {
        const { mtimeMs } = await stat(join(project.dir, path));
        const content = createHash("sha256")
          .update(await readFile(join(project.dir, path)))
          .digest("hex");
        files[path] = `${content} ${mtimeMs}`;
      }
    }
  };
  await walk("");
  const index = createHash("sha256")
    .update(await readFile(join(project.dir, ".git", "index")))
    .digest("hex");
  return {
    files,
    index,
    status: await project.git("status", "--porcelain=v1", "--ignored", "-uall"),
    stash: await project.git("stash", "list"),
    refs: await project.git("for-each-ref"),
    head: await project.git("rev-parse", "HEAD"),
    branch: await project.git("branch", "--show-current"),
    worktrees: await project.git("worktree", "list", "--porcelain"),
    staged: await project.git("diff", "--cached"),
    unstaged: await project.git("diff"),
  };
}
