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
 *
 * `prepare` and `link` say what the base gets that a fresh checkout lacks. Unsaid, the working tree's dependencies
 * are linked into the base when there is no `prepare`, and are not when there is one, which installs the base's own.
 * `"link": true` links them before a `prepare` that needs them and does not install (a project that compiles what
 * git ignores, as a `postinstall` does), and `"link": false` links nothing, `prepare` or not: the key says what is
 * done, whatever the other one says. `"link": true` with a `prepare` that installs is refused (`installIn`): the
 * install would write through the links into the working tree's node_modules.
 */

export const CONFIG_FILE = "downtrace.json";

export interface CheckConfig {
  /** The test command, run by a shell. Absent: it has to come from the command line. */
  command: string | undefined;
  /** Run in the base checkout before the tests, for what a fresh checkout lacks. */
  prepare: string | undefined;
  /**
   * Whether the working tree's dependencies and environment files are linked into the base, before `prepare`.
   * Absent: they are when there is no `prepare`, and are not when there is.
   */
  link: boolean | undefined;
  /** Routes the project has, as `METHOD /template`: what lets a route no test calls be named. */
  routes: string[];
  /** How long a test run may take, in seconds. Absent: the default. */
  timeoutSeconds: number | undefined;
}

export type ConfigResult = { ok: true; config: CheckConfig } | { ok: false; reason: string };

export const EMPTY_CONFIG: CheckConfig = {
  command: undefined,
  prepare: undefined,
  link: undefined,
  routes: [],
  timeoutSeconds: undefined,
};

/** The keys of `check`, in the order the README documents them. */
export const CONFIG_KEYS = ["command", "routes", "prepare", "link", "timeout"] as const;

/** The package managers whose installs `installIn` sees. */
export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
/**
 * What, after a package manager and its options, writes into node_modules: the names, of any of them, of an
 * install, an update, a removal, a link and a build of what is installed. `yarn` alone installs too.
 */
export const INSTALLING_VERBS = [
  "install",
  "i",
  "ci",
  "clean-install",
  "install-test",
  "it",
  "install-ci-test",
  "cit",
  "add",
  "update",
  "up",
  "upgrade",
  "remove",
  "rm",
  "uninstall",
  "un",
  "link",
  "ln",
  "unlink",
  "rebuild",
  "rb",
  "dedupe",
  "prune",
  "import",
] as const;

const WORD_START = "(?:^|[\\s;&|()])";
const WORD_END = "(?=$|[\\s;&|()])";
/** An option, and the value it may take: `--filter api`, `--prefix ../..`, `-r`. */
const OPTION = "\\s+-[^\\s;&|()]*(?:\\s+[^\\s;&|()-][^\\s;&|()]*)?";
const INSTALL = new RegExp(
  `${WORD_START}((?:${PACKAGE_MANAGERS.join("|")})(?:${OPTION})*\\s+(?:${INSTALLING_VERBS.join("|")})${WORD_END}` +
    `|yarn(?:\\s+-[^\\s;&|()]*)*\\s*(?=$|[;&|)]))`,
);

/**
 * The install a command line runs itself, as written (`pnpm --filter api install`), or undefined. One in a script
 * it runs (`npm run setup`) is not seen.
 */
export function installIn(command: string): string | undefined {
  return INSTALL.exec(command)?.[1]?.trim();
}

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
  if (check.link !== undefined && typeof check.link !== "boolean") return fail('"check.link" must be true or false');
  const install = check.link === true && typeof check.prepare === "string" ? installIn(check.prepare) : undefined;
  if (install !== undefined) {
    return fail(
      `"check.link" is true and "check.prepare" installs (${install}): the install would write through the links ` +
        `into the working tree's node_modules. Leave "link" out, and prepare installs the base's own dependencies; ` +
        "or keep it, and take the install out of prepare.",
    );
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
      link: check.link,
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
