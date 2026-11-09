import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { USAGE } from "./check/args.ts";
import { VERSION_ENV_VARS } from "./config.ts";
import { COMMIT, STAMP_FILE } from "./deployed.ts";

/**
 * `downtrace stamp` (DT-223): writes the commit a build is made from into `.downtrace-version`, in the directory it
 * runs in, for the instrumentation to report as the deployed version where no variable names it (`deployed.ts`).
 *
 * The running application may have no variable that names its commit, and nobody who can add one: an ECS task whose
 * environment and start command belong to another company. Its build knows the commit, and the build is the
 * developer's. So the commit is taken there, in this order:
 *
 * 1. `--commit <sha>`, when the build says it;
 * 2. git's `HEAD`, which is the checkout being built;
 * 3. the first variable of `VERSION_ENV_VARS` that holds a commit: a CI's (`GITHUB_SHA`,
 *    `CODEBUILD_RESOLVED_SOURCE_VERSION`, `CI_COMMIT_SHA`…), which names what started the run. After git, because a
 *    workflow may check out another commit than the one that started it; and the one there is where a build has no
 *    `.git`, as a Docker build whose `.dockerignore` leaves it out.
 *
 * Exit status: 0 written; 1 no commit was found, and nothing was written; 2 a wrong option, or a file that could not
 * be written.
 */

/** How long git has to name its `HEAD`: a read of the checkout, on a build machine that may be slow. */
export const GIT_TIMEOUT_MS = 10_000;

export interface StampDeps {
  /** The words after `downtrace stamp`. */
  argv: readonly string[];
  /** Where the file is written, and where git is asked. */
  cwd: string;
  /** The environment, read once at start-up: the CI's variables, and the one git runs with. */
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal: AbortSignal;
}

type Found = { commit: string; from: string } | { why: string };

export async function runStamp(deps: StampDeps): Promise<number> {
  const parsed = parseStampArgs(deps.argv);
  if (parsed.kind === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    deps.stderr(`downtrace stamp: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const found: Found =
    parsed.commit === undefined ? await commitOfBuild(deps) : { commit: parsed.commit, from: "--commit" };
  if ("why" in found) {
    deps.stderr(
      `downtrace stamp: no commit to write: git could not read one (${found.why}), and no variable of a CI holds one. ` +
        "Give it with --commit <sha>, or pass the CI's commit to this step: GITHUB_SHA, CODEBUILD_RESOLVED_SOURCE_VERSION, " +
        "CI_COMMIT_SHA, GIT_COMMIT or another the instrumentation reads. Nothing was written.\n",
    );
    return 1;
  }
  const file = path.join(path.resolve(deps.cwd), STAMP_FILE);
  try {
    await writeFile(file, `${found.commit}\n`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    deps.stderr(`downtrace stamp: ${file} could not be written (${code ?? String(err)})\n`);
    return 2;
  }
  deps.stdout(`wrote ${found.commit} to ${file}, from ${found.from}\n`);
  return 0;
}

type Parsed = { kind: "help" } | { kind: "error"; message: string } | { kind: "stamp"; commit: string | undefined };

/** Reads what comes after `downtrace stamp`: `--commit <sha>`, or nothing. */
function parseStampArgs(argv: readonly string[]): Parsed {
  let commit: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    const at = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = at === -1 ? arg : arg.slice(0, at);
    if (name === "--commit") {
      let value = at === -1 ? undefined : arg.slice(at + 1);
      if (value === undefined) {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value.trim() === "") return { kind: "error", message: "--commit needs a value" };
      if (!COMMIT.test(value.trim())) {
        return { kind: "error", message: `--commit wants a commit, 7 to 40 hexadecimal digits, not "${value}"` };
      }
      commit = value.trim().toLowerCase();
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown option ${arg} for stamp` };
    return { kind: "error", message: `unexpected "${arg}": stamp writes into the directory it runs in` };
  }
  return { kind: "stamp", commit };
}

/** The commit of the build, from git and then from a CI's variable; or why git had none. */
async function commitOfBuild(deps: StampDeps): Promise<Found> {
  const git = await gitHead(deps);
  if ("commit" in git) return git;
  for (const name of VERSION_ENV_VARS) {
    const value = deps.env[name]?.trim();
    if (value !== undefined && COMMIT.test(value)) return { commit: value.toLowerCase(), from: name };
  }
  return git;
}

/** `git rev-parse --verify HEAD` where the build runs, with a timeout; never rejects. */
function gitHead(deps: StampDeps): Promise<Found> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      { cwd: deps.cwd, env: deps.env, timeout: GIT_TIMEOUT_MS, signal: deps.signal },
      (err, stdout, stderr) => {
        if (err !== null) {
          const failed = err as NodeJS.ErrnoException & { killed?: boolean };
          if (failed.code === "ENOENT") resolve({ why: "git is not installed here" });
          else if (failed.killed === true) resolve({ why: `git did not answer within ${GIT_TIMEOUT_MS / 1000} s` });
          else resolve({ why: String(stderr).trim().split("\n")[0] || failed.message });
          return;
        }
        const head = String(stdout).trim();
        resolve(
          COMMIT.test(head)
            ? { commit: head.toLowerCase(), from: "git" }
            : { why: "git named its HEAD with something other than 7 to 40 hexadecimal digits" },
        );
      },
    );
  });
}
