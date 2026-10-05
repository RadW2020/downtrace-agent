import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * What `downtrace check` needs to know about a project, written down once so that nobody has to be asked.
 *
 * It lives in `downtrace.json`, at the root of the project (or of the repository, for a project that is a
 * directory of it), and it is the one thing `downtrace init` writes for `check` to read:
 *
 * ```json
 * {
 *   "check": {
 *     "command": "npm test",
 *     "routes": ["GET /products", "POST /checkout"],
 *     "prepare": "pnpm install --offline --frozen-lockfile",
 *     "timeout": 900
 *   }
 * }
 * ```
 *
 * Every key of `check` is optional, and a command on the command line takes the place of `command`. A key
 * `check` does not know is an error and not a shrug: «commmand» left alone would be a missing command said in
 * the wrong words. Keys outside `check` are not this file's to judge.
 */

export const CONFIG_FILE = "downtrace.json";

export interface CheckConfig {
  /** The test command, run by a shell. Absent: it has to come from the command line. */
  command: string | undefined;
  /** Run in the base checkout before the tests, for what a fresh checkout lacks. */
  prepare: string | undefined;
  /** Routes the project has, as `METHOD /template`: what lets a route no test calls be named. */
  routes: string[];
  /** How long a test run may take, in seconds. Absent: the default. */
  timeoutSeconds: number | undefined;
}

export type ConfigResult = { ok: true; config: CheckConfig } | { ok: false; reason: string };

export const EMPTY_CONFIG: CheckConfig = {
  command: undefined,
  prepare: undefined,
  routes: [],
  timeoutSeconds: undefined,
};

/** The keys of `check`, in the order the README documents them. */
export const CONFIG_KEYS = ["command", "prepare", "routes", "timeout"] as const;

/** `["npm", "test", "--", "a b"]` as one line a shell reads back the same way. */
export function shellJoin(args: readonly string[]): string {
  return args
    .map((arg) => (/^[A-Za-z0-9_\-./:=,@%+]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

/** `get /products` as `GET /products`, or undefined when it is not a method and a template. */
export function declaredRoute(text: string): string | undefined {
  const match = /^([A-Za-z]+) (\/\S*)$/.exec(text.trim());
  return match?.[1] === undefined || match[2] === undefined ? undefined : `${match[1].toUpperCase()} ${match[2]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the text of a configuration file. Pure: the file is read by whoever calls it. */
export function parseConfig(text: string, source: string): ConfigResult {
  const fail = (reason: string): ConfigResult => ({ ok: false, reason: `${source}: ${reason}` });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return fail(`not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(value)) return fail("it must be a JSON object");
  const check = value.check;
  if (check === undefined) return { ok: true, config: EMPTY_CONFIG };
  if (!isRecord(check)) return fail('"check" must be an object');
  for (const key of Object.keys(check)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      return fail(`"check.${key}" is not a key of this file (known: ${CONFIG_KEYS.join(", ")})`);
    }
  }

  let command: string | undefined;
  if (typeof check.command === "string" && check.command.trim() !== "") command = check.command;
  else if (
    Array.isArray(check.command) &&
    check.command.length > 0 &&
    check.command.every((part) => typeof part === "string")
  ) {
    command = shellJoin(check.command as string[]);
  } else if (check.command !== undefined) {
    return fail('"check.command" must be a command line, or a list of words that make one');
  }

  if (check.prepare !== undefined && (typeof check.prepare !== "string" || check.prepare.trim() === "")) {
    return fail('"check.prepare" must be a command line');
  }

  const routes: string[] = [];
  if (check.routes !== undefined) {
    if (!Array.isArray(check.routes)) return fail('"check.routes" must be a list of "METHOD /template"');
    for (const entry of check.routes) {
      const route = typeof entry === "string" ? declaredRoute(entry) : undefined;
      if (route === undefined) return fail(`"check.routes" has ${JSON.stringify(entry)}: write it as "GET /products"`);
      routes.push(route);
    }
  }

  const timeout = check.timeout;
  if (timeout !== undefined && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) {
    return fail('"check.timeout" must be a number of seconds above zero');
  }

  return {
    ok: true,
    config: {
      command,
      prepare: typeof check.prepare === "string" ? check.prepare : undefined,
      routes,
      timeoutSeconds: typeof timeout === "number" ? timeout : undefined,
    },
  };
}

/**
 * The configuration file nearest to `start`, looking up to `root` (the repository's top): a project may be one
 * directory of a monorepo, and `check` is run from it or from below it.
 */
export async function findConfig(start: string, root: string): Promise<{ path: string; text: string } | undefined> {
  let dir = start;
  for (;;) {
    const path = join(dir, CONFIG_FILE);
    try {
      return { path, text: await readFile(path, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (dir === root || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}
