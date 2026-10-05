import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { compareRuns, type RouteResult, summarize } from "./compare.ts";
import { adviceForNoProfile } from "./hints.ts";
import { type RunTally, readRunFile } from "./read.ts";
import {
  type CheckReport,
  compared,
  type Failure,
  type FailureCode,
  failed,
  type Side,
  type SideReport,
} from "./report.ts";

/**
 * The comparison before the deploy, end to end (LOC-01): the project's tests run twice, on a base and on the
 * working tree, with the instrumentation writing locally, and what each run left is compared by composition.
 *
 * Four things this is careful about, because they are what the person trusts it with:
 *
 * - **Nothing leaves the machine.** The runs get no token and no URL (every `DOWNTRACE_` variable of the caller is
 *   dropped), so the instrumentation can only write a file; `git` is told not to fetch what a checkout would
 *   (LFS) nor to ask for a password.
 * - **The working tree is not touched.** The base runs in a temporary worktree of its own, outside the
 *   repository, which is removed when the runs end, however they ended. Nothing is checked out, stashed or reset
 *   in the caller's tree, and its index is not read for a status.
 * - **A run that left nothing is said, not shown as unchanged.** See `hints.ts`.
 * - **Every wait has an end.** The test command has a timeout and an abort signal; each `git` has a timeout.
 */

export const DEFAULT_TIMEOUT_SECONDS = 900;

/** One `git` call. A checkout of a large repository is the slow one. */
const GIT_TIMEOUT_MS = 120_000;
/** Between asking a process group to stop and making it. */
const KILL_GRACE_MS = 5_000;
/** How long the output of a finished command is given to close before what still holds it is stopped. */
const STREAM_GRACE_MS = 1_500;
/** The last of a command's output kept, for the failure that needs it. */
const OUTPUT_TAIL_CHARS = 4_000;
/** How far below the project a directory of dependencies is looked for. */
const LINK_DEPTH = 3;

/**
 * One second: the instrumentation closes an interval and a profile window at least this often, so that what a
 * process that ends abruptly loses is at most this much, and not the minute it keeps for production.
 */
const WINDOW_MS = "1000";

export interface CheckOptions {
  /** Where `check` was run from: the project, or a directory of it. */
  cwd: string;
  /** The ref the base is checked out at; `HEAD` when absent. */
  base: string | undefined;
  /** The test command, run by a shell. */
  command: string;
  /** Run in the base before the tests; when it is given the base's dependencies are its business, not ours. */
  prepare: string | undefined;
  /** Routes the project declares, so that one no test calls can be named. */
  routes: readonly string[];
  timeoutMs: number;
  /** The caller's environment, read once at start-up and passed in. */
  env: NodeJS.ProcessEnv;
  /** The instrumentation's `register` entry, as a URL: what the runs preload. */
  registerUrl: string;
  /** Where temporary directories are made. */
  tmpRoot: string;
  signal: AbortSignal | undefined;
  /** Where progress goes: a person watching a run that takes minutes. */
  progress: (line: string) => void;
}

/** What the failure needs to say, thrown to unwind through the cleanup and become the report. */
class CheckFailure extends Error {
  readonly failure: Failure;
  /** The routes, when the failure is that none of them could be evaluated: each says why. */
  readonly routes: RouteResult[];
  constructor(
    code: FailureCode,
    side: Side | null,
    message: string,
    extra: Partial<Failure> & { routes?: RouteResult[] } = {},
  ) {
    super(message);
    const { routes = [], ...failure } = extra;
    this.failure = { code, side, message, advice: null, outputTail: null, ...failure };
    this.routes = routes;
  }
}

// --- git ---------------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Redirections a hook leaves in the environment would point these commands somewhere else than the project.
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...rest } = env;
  return { ...rest, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

class GitError extends Error {}

/** The top of the repository `cwd` is in, or undefined when it is in none. */
export async function repositoryTop(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return await realpath(await git(["rev-parse", "--show-toplevel"], { cwd, env, signal: undefined }));
  } catch {
    // Not a repository: the caller says so when it needs one, and looks for its configuration only where it is.
    return undefined;
  }
}

async function git(args: string[], where: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal | undefined }) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: where.cwd,
      env: gitEnv(where.env),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      ...(where.signal === undefined ? {} : { signal: where.signal }),
    });
    return stdout.trim();
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") throw new GitError("git is not installed, or is not on the PATH");
    const said = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    throw new GitError(`git ${args.join(" ")} failed${said === "" ? `: ${failure.message}` : `: ${said}`}`);
  }
}

// --- running a command ---------------------------------------------------------------------------------------

export interface CommandRun {
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
  timedOut: boolean;
  aborted: boolean;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // The group is already gone: what it was asked to do is done.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/**
 * Runs a command line in a shell, in a process group of its own so that what it started can be stopped with it.
 * Its output is not shown: only the last of it is kept, for the failure that needs it.
 */
export function runCommand(spec: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}): Promise<CommandRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(spec.command, {
      shell: true,
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let hardKill: NodeJS.Timeout | undefined;
    let streams: NodeJS.Timeout | undefined;
    const stop = (): void => {
      signalGroup(child.pid, "SIGTERM");
      hardKill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      clearTimeout(streams);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, durationMs: performance.now() - started, outputTail: tail, timedOut, aborted });
    };
    child.on("error", (err) => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      spec.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => finish(code));
    // The command is over, but something it started still holds its output: that is a server a test left
    // running, which would still hold its port for the next run. It goes with the command that started it.
    child.on("exit", (code) => {
      streams = setTimeout(() => {
        signalGroup(child.pid, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, STREAM_GRACE_MS);
    });
  });
}

// --- the environment of a run -----------------------------------------------------------------------------

/** The environment with every `DOWNTRACE_` variable of the caller left out: what it set is for production. */
function withoutDowntrace(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (!name.startsWith("DOWNTRACE_")) env[name] = value;
  }
  return env;
}

/**
 * The environment a test run gets. Loaded through `NODE_OPTIONS` and not through `--import` on the command
 * line: a runner's workers do not inherit the command line (Vitest's do not), and `NODE_OPTIONS` reaches every
 * process and thread. No token and no URL, so the instrumentation can only write the file.
 */
export function runEnv(
  parent: NodeJS.ProcessEnv,
  run: { registerUrl: string; inspectFile: string; side: Side },
): NodeJS.ProcessEnv {
  const env = withoutDowntrace(parent);
  const preload = `--import=${run.registerUrl}`;
  env.NODE_OPTIONS = parent.NODE_OPTIONS ? `${parent.NODE_OPTIONS} ${preload}` : preload;
  env.DOWNTRACE_INSPECT = run.inspectFile;
  env.DOWNTRACE_INTERVAL_MS = WINDOW_MS;
  env.DOWNTRACE_PROFILE_MS = WINDOW_MS;
  env.DOWNTRACE_ENV = "check";
  env.DOWNTRACE_VERSION = run.side;
  // A package manager that finds the dependencies it is asked to run with out of date may install them, and the
  // base's are the project's own, linked: nothing a check runs may write into them.
  if (run.side === "base") env.npm_config_verify_deps_before_run = "false";
  return env;
}

// --- the base ----------------------------------------------------------------------------------------------

/**
 * Links each directory of dependencies of the working tree into the base, in the same place. A fresh checkout has
 * none, and installing them would need the network. The base then runs on the project's own dependencies:
 * a package of the repository itself, linked into them, is the working tree's and not the base's — what
 * `prepare` is for.
 */
async function linkDependencies(top: string, base: string): Promise<string[]> {
  const links: string[] = [];
  let level = [""];
  for (let depth = 0; depth <= LINK_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(join(top, dir), { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.name === "node_modules") {
          if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
          const into = join(base, path);
          const parent = await stat(join(base, dir)).catch(() => undefined);
          const present = await stat(into).catch(() => undefined);
          if (parent?.isDirectory() === true && present === undefined) {
            await symlink(join(top, path), into, "dir");
            links.push(into);
          }
        } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
          next.push(path);
        }
      }
    }
    level = next;
  }
  return links;
}

function inside(parent: string, path: string): boolean {
  const from = relative(parent, path);
  return from === "" || (!from.startsWith("..") && !from.startsWith(sep));
}

// --- the check ---------------------------------------------------------------------------------------------

function sideReport(ref: string, commit: string | null, command: string, ran: CommandRun, tally: RunTally): SideReport {
  return {
    ref,
    commit,
    command,
    exitCode: ran.exitCode,
    durationMs: Math.round(ran.durationMs),
    processes: tally.processes,
    batches: tally.batches,
    requests: tally.requests,
    routes: [...tally.routes.values()].filter((route) => route.requests > 0).length,
    profileWindows: tally.profileWindows,
    malformed: tally.malformed,
    observers: tally.observers,
  };
}

/** What `runCheck` has made, so that it can be unmade however the run ended. */
interface Made {
  tmp: string | undefined;
  worktree: { top: string; dir: string } | undefined;
  links: string[];
  sides: { base: SideReport | null; change: SideReport | null };
}

/** Takes the worktree away, and says what could not be taken away: a directory left behind is not silent. */
async function cleanUp(made: Made, env: NodeJS.ProcessEnv): Promise<string[]> {
  const problems: string[] = [];
  const said = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  // The links first: they point into the project's own dependencies, and nothing may follow them.
  for (const link of made.links) {
    try {
      await rm(link, { force: true });
    } catch (err) {
      problems.push(`could not remove the link ${link}: ${said(err)}`);
    }
  }
  const { worktree, tmp } = made;
  if (worktree !== undefined) {
    const where = { cwd: worktree.top, env, signal: undefined };
    try {
      await git(["worktree", "remove", "--force", worktree.dir], where);
    } catch (first) {
      try {
        await rm(worktree.dir, { recursive: true, force: true });
        await git(["worktree", "prune"], where);
      } catch (second) {
        problems.push(
          `the temporary worktree ${worktree.dir} was not removed (${said(first)}; ${said(second)}): ` +
            `remove it with "git worktree remove --force ${worktree.dir}"`,
        );
      }
    }
  }
  if (tmp !== undefined) {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch (err) {
      problems.push(`could not remove ${tmp}: ${said(err)}`);
    }
  }
  return problems;
}

/** What the reader should keep in mind about this comparison, beyond the verdicts. */
function notesOf(command: string, tallies: Map<Side, RunTally>, routes: readonly RouteResult[]): string[] {
  const notes: string[] = [];
  for (const side of ["base", "change"] as const) {
    const tally = tallies.get(side);
    if (tally === undefined) continue;
    const lost = [...tally.routes.values()].reduce((sum, route) => sum + route.unprofiledRequests, 0);
    if (lost > 0) {
      notes.push(
        `On the ${side}, ${lost} request${lost === 1 ? "" : "s"} made calls that no profile covers: what each ` +
          "route ran is counted over the requests a profile does cover. " +
          adviceForNoProfile(command),
      );
    }
    if (tally.malformed > 0) {
      notes.push(
        `${tally.malformed} line${tally.malformed === 1 ? "" : "s"} of the ${side} run's file could not be read and were left out.`,
      );
    }
    for (const [driver, state] of Object.entries(tally.observers)) {
      if (state.includes("unavailable")) {
        notes.push(
          `On the ${side}, the ${driver} observer was unavailable: the driver could not be resolved from the ` +
            `application's entry, so what it would have seen is absent from the ${side} run, not zero.`,
        );
      }
    }
  }
  if (routes.some((route) => route.reasons.some((reason) => reason.code.startsWith("no-profile")))) {
    notes.push(`Some routes had requests and no profile. ${adviceForNoProfile(command)}`);
  }
  return notes;
}

/** Runs the tests of the project on the base and on the working tree, and compares what each one did. */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const made: Made = { tmp: undefined, worktree: undefined, links: [], sides: { base: null, change: null } };
  let report: CheckReport;
  try {
    report = await check(options, made);
  } catch (err) {
    // What nobody expected — a directory that cannot be read, a disk that is full — is still a comparison that
    // could not be made: the status CI reads is 2, and never the 1 a stack trace would end the process with.
    const failure =
      options.signal?.aborted === true
        ? new CheckFailure("interrupted", null, "interrupted before it ended: nothing was compared")
        : err instanceof CheckFailure
          ? err
          : new CheckFailure(
              "setup-failed",
              null,
              `check could not run: ${err instanceof Error ? err.message : String(err)}`,
            );
    report = failed({ failure: failure.failure, ...made.sides, routes: failure.routes });
  }
  const problems = await cleanUp(made, options.env);
  return problems.length === 0 ? report : { ...report, notes: [...report.notes, ...problems] };
}

async function check(options: CheckOptions, made: Made): Promise<CheckReport> {
  const where = { env: options.env, signal: options.signal };
  const cwd = await realpath(options.cwd);
  let top: string;
  try {
    top = await realpath(await git(["rev-parse", "--show-toplevel"], { cwd, ...where }));
  } catch (err) {
    throw new CheckFailure(
      "not-a-repository",
      null,
      `${cwd} is not inside a git repository (${(err as Error).message})`,
      {
        advice: "check compares the working tree with a commit, so the project has to be a git repository.",
      },
    );
  }
  const ref = options.base ?? "HEAD";
  let commit: string;
  try {
    if (ref.startsWith("-")) throw new GitError("a ref cannot start with a dash");
    commit = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: top, ...where });
  } catch {
    throw new CheckFailure("bad-ref", null, `the base "${ref}" is not a commit of this repository`, {
      advice: "Pass --base with a branch, a tag or a commit that exists here, for example --base origin/main.",
    });
  }
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: top, ...where }).catch(() => null);
  const project = relative(top, cwd);

  const tmp = await mkdtemp(join(await realpath(options.tmpRoot), "downtrace-check-"));
  made.tmp = tmp;
  if (inside(top, tmp)) {
    throw new CheckFailure("setup-failed", "base", `the temporary directory ${tmp} is inside the repository`, {
      advice: "The base is checked out beside the repository, never in it: set TMPDIR to a directory outside it.",
    });
  }
  const baseDir = join(tmp, "base");
  options.progress(`base: checking out ${commit.slice(0, 9)} (${ref}) in ${baseDir}`);
  try {
    // Without hooks: a post-checkout hook of the project is its code running on a checkout nobody asked for.
    await git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", baseDir, commit], {
      cwd: top,
      ...where,
    });
  } catch (err) {
    throw new CheckFailure("setup-failed", "base", `could not check out the base: ${(err as Error).message}`);
  }
  made.worktree = { top, dir: baseDir };
  const baseProject = join(baseDir, project);
  if ((await stat(baseProject).catch(() => undefined))?.isDirectory() !== true) {
    throw new CheckFailure("setup-failed", "base", `the base has no directory "${project}", where check was run`, {
      advice: "A project that did not exist in the base has nothing to be compared with.",
    });
  }

  if (options.prepare === undefined) {
    try {
      made.links.push(...(await linkDependencies(top, baseDir)));
    } catch (err) {
      throw new CheckFailure(
        "setup-failed",
        "base",
        `could not link the dependencies into the base: ${(err as Error).message}`,
      );
    }
  } else {
    options.progress(`base: preparing: ${options.prepare}`);
    const prepared = await runCommand({
      command: options.prepare,
      cwd: baseProject,
      env: { ...withoutDowntrace(options.env), DOWNTRACE_CHECK_ORIGIN: cwd },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }).catch((err: unknown) => {
      throw new CheckFailure("setup-failed", "base", `could not start the prepare command: ${(err as Error).message}`);
    });
    if (prepared.timedOut || prepared.exitCode !== 0) {
      throw new CheckFailure(
        "setup-failed",
        "base",
        `the prepare command ${prepared.timedOut ? "timed out" : `exited with ${prepared.exitCode ?? "no status"}`}`,
        { outputTail: prepared.outputTail },
      );
    }
  }

  const tallies = new Map<Side, RunTally>();
  for (const [side, dir, label, sha] of [
    ["base", baseProject, ref, commit],
    ["change", cwd, "working tree", head],
  ] as const) {
    const file = join(tmp, `${side}.jsonl`);
    options.progress(`${side}: running ${options.command}`);
    const ran = await runCommand({
      command: options.command,
      cwd: dir,
      env: runEnv(options.env, { registerUrl: options.registerUrl, inspectFile: file, side }),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }).catch((err: unknown) => {
      throw new CheckFailure("setup-failed", side, `could not start the test command: ${(err as Error).message}`);
    });
    const tally = await readRunFile(file);
    tallies.set(side, tally);
    made.sides[side] = sideReport(label, sha, options.command, ran, tally);
    if (ran.timedOut) {
      throw new CheckFailure(
        "timeout",
        side,
        `the test command did not end within ${Math.round(options.timeoutMs / 1000)} s`,
        {
          outputTail: ran.outputTail,
        },
      );
    }
    if (ran.exitCode !== 0) {
      const what = ran.aborted
        ? "the test command was stopped"
        : `the test command exited with ${ran.exitCode ?? "no status"}`;
      const fix = side === "base" ? `make the tests pass on ${ref}, or choose another --base` : "fix the tests first";
      throw new CheckFailure("command-failed", side, what, {
        advice: `A comparison needs two runs that end well: ${fix}.`,
        outputTail: ran.outputTail,
      });
    }
    if (tally.requests === 0) {
      throw new CheckFailure("no-profile", side, "the run left no profile", {
        advice: adviceForNoProfile(options.command),
        outputTail: ran.outputTail,
      });
    }
    options.progress(`${side}: ${tally.requests} requests on ${made.sides[side]?.routes ?? 0} routes`);
  }

  const base = tallies.get("base");
  const change = tallies.get("change");
  if (base === undefined || change === undefined || made.sides.base === null || made.sides.change === null) {
    throw new CheckFailure("setup-failed", null, "a run is missing: this is a bug in check");
  }
  const routes = compareRuns(base, change, options.routes);
  if (summarize(routes).worse + summarize(routes).unchanged === 0) {
    const lost = routes.some((route) => route.reasons.some((reason) => reason.code.startsWith("no-profile")));
    throw new CheckFailure(
      "nothing-evaluated",
      null,
      "no route could be evaluated, so nothing is said about any of them",
      {
        ...(lost ? { advice: adviceForNoProfile(options.command) } : {}),
        routes,
      },
    );
  }
  return compared({
    base: made.sides.base,
    change: made.sides.change,
    routes,
    notes: notesOf(options.command, tallies, routes),
  });
}
