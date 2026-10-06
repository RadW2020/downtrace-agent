/**
 * The command line of `downtrace`: a hand-written reading, because the package has no dependencies to spend on one.
 *
 *     downtrace check [--base <ref>] [--json] [--config <file>] [--timeout <seconds>] [-- <test command>]
 *     downtrace init [--json]
 *
 * The test command comes after `--` so that its own flags are its own and never this one's.
 */

export type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "check";
      /** The ref the base is checked out at; undefined means `HEAD`. */
      base: string | undefined;
      json: boolean;
      config: string | undefined;
      timeoutSeconds: number | undefined;
      /** The words after `--`. Empty when the test command is to come from the configuration. */
      command: string[];
    }
  | { kind: "init"; json: boolean }
  | { kind: "error"; message: string };

export const USAGE = `Usage: downtrace check [options] [-- <test command>]
       downtrace init [--json]

check runs the tests of the project on a base and on the working tree with the instrumentation writing locally,
and compares them route by route, by composition: which queries, outgoing calls and Redis commands each request
ran, and how many times. Nothing leaves the machine. Durations are shown and never judged.

Options of check:
  --base <ref>         what to compare against; default HEAD (what is not committed yet)
  --json               print the result as JSON, for a coding agent
  --config <file>      the configuration file; default downtrace.json, looked for upwards
  --timeout <seconds>  how long each test run may take; default 900

The test command is what comes after "--", or "check.command" of downtrace.json.
Exit status of check: 0 no route got worse, 1 at least one did, 2 no comparison could be made.

init looks at the project in this directory (package.json, its lockfile, next.config, tsconfig.json) and writes
downtrace.json with its test command, and the instrumentation.ts a Next.js build with output "standalone" needs.
It asks nothing and makes no network request. Run it again at any time: what is there already is kept.

Options of init:
  --json               print the result as JSON, for a coding agent

Exit status of init: 0 configured, 1 something could not be detected or done (it says what to do instead),
2 a file it reads could not be read, and nothing was written.

  -h, --help           this text
  -v, --version        the version
`;

/** Reads what comes after `node downtrace`. */
export function parseArgs(argv: readonly string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined || first === "-h" || first === "--help" || first === "help") return { kind: "help" };
  if (first === "-v" || first === "--version" || first === "version") return { kind: "version" };
  if (first === "init") return parseInit(rest);
  if (first !== "check") {
    return { kind: "error", message: `unknown command "${first}": the ones there are are "check" and "init"` };
  }

  let base: string | undefined;
  let json = false;
  let config: string | undefined;
  let timeoutSeconds: number | undefined;
  let command: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (arg === "--") {
      command = rest.slice(i + 1);
      break;
    }
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    const [name = "", inline] = arg.startsWith("--") ? splitOnce(arg, "=") : [arg, undefined];
    if (name === "--base" || name === "--config" || name === "--timeout") {
      let value = inline;
      if (value === undefined) {
        i += 1;
        value = rest[i];
      }
      if (value === undefined || value === "") return { kind: "error", message: `${name} needs a value` };
      if (name === "--base") base = value;
      else if (name === "--config") config = value;
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return { kind: "error", message: `--timeout wants a number of seconds above zero, not "${value}"` };
        }
        timeoutSeconds = seconds;
      }
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown option ${arg}` };
    return { kind: "error", message: `unexpected "${arg}": the test command goes after --` };
  }
  return { kind: "check", base, json, config, timeoutSeconds, command };
}

/** Reads what comes after `downtrace init`: it takes `--json` and nothing else. */
function parseInit(rest: readonly string[]): Parsed {
  let json = false;
  for (const arg of rest) {
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--json") json = true;
    else if (arg.startsWith("-")) return { kind: "error", message: `unknown option ${arg} for init` };
    else return { kind: "error", message: `unexpected "${arg}": init looks at the directory it runs in` };
  }
  return { kind: "init", json };
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}
