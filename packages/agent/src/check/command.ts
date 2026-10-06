import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInit } from "../init/command.ts";
import { type Parsed, parseArgs, USAGE } from "./args.ts";
import { type ConfigResult, EMPTY_CONFIG, findConfig, parseConfig, shellJoin } from "./config.ts";
import { renderJson, renderText } from "./render.ts";
import { type CheckReport, exitCodeOf, failed } from "./report.ts";
import { DEFAULT_TIMEOUT_SECONDS, repositoryTop, runCheck } from "./run.ts";

/** What the command needs from the process it runs in, passed in and not reached for. */
export interface CliDeps {
  argv: readonly string[];
  /** The environment, read once at start-up. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  tmpRoot: string;
  /** The instrumentation's `register` entry, as a URL. */
  registerUrl: string;
  version: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal: AbortSignal | undefined;
}

/** The configuration: the file asked for, or the nearest one up to the top of the repository, or none. */
async function loadConfig(cwd: string, asked: string | undefined, env: NodeJS.ProcessEnv): Promise<ConfigResult> {
  try {
    if (asked !== undefined) {
      const path = resolve(cwd, asked);
      return parseConfig(await readFile(path, "utf8"), path);
    }
    const found = await findConfig(cwd, (await repositoryTop(cwd, env)) ?? cwd);
    return found === undefined ? { ok: true, config: EMPTY_CONFIG } : parseConfig(found.text, found.path);
  } catch (err) {
    return {
      ok: false,
      reason: `the configuration could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * `downtrace`, as a function: reads the command line and the configuration, runs the check and says the result,
 * or hands `init` to its own command. Returns the exit status, so that nothing in here ends the process.
 *
 * What goes to stdout is the result and nothing else — the text, or the JSON — so that `--json` can be piped;
 * the progress of a run that takes minutes goes to stderr.
 */
export async function runCli(deps: CliDeps): Promise<number> {
  const parsed: Parsed = parseArgs(deps.argv);
  if (parsed.kind === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    deps.stdout(`${deps.version}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    deps.stderr(`downtrace: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.kind === "init") return runInit({ cwd: deps.cwd, json: parsed.json, stdout: deps.stdout });

  const say = (report: CheckReport): number => {
    deps.stdout(parsed.json ? renderJson(report) : renderText(report));
    return exitCodeOf(report);
  };
  const stop = (code: "bad-config" | "no-command", message: string, advice: string | null = null): number =>
    say(failed({ failure: { code, side: null, message, advice, outputTail: null } }));

  const cwd = resolve(deps.cwd);
  const loaded = await loadConfig(cwd, parsed.config, deps.env);
  if (!loaded.ok) return stop("bad-config", loaded.reason);
  const configured = loaded.config;

  const command = parsed.command.length > 0 ? shellJoin(parsed.command) : configured.command;
  if (command === undefined) {
    return stop(
      "no-command",
      "there is no test command to run",
      'Pass it after --, for example `downtrace check -- npm test`, or write it in downtrace.json as {"check": {"command": "npm test"}}.',
    );
  }
  const timeoutSeconds = parsed.timeoutSeconds ?? configured.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const report = await runCheck({
    cwd,
    base: parsed.base,
    command,
    prepare: configured.prepare,
    routes: configured.routes,
    timeoutMs: timeoutSeconds * 1000,
    env: deps.env,
    registerUrl: deps.registerUrl,
    tmpRoot: deps.tmpRoot,
    signal: deps.signal,
    progress: (line) => deps.stderr(`downtrace: ${line}\n`),
  });
  return say(report);
}
