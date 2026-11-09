/**
 * The command line of `downtrace`: a hand-written reading, because the package has no dependencies to spend on one.
 *
 *     downtrace check [--base <ref>] [--json] [--config <file>] [--timeout <seconds>] [-- <test command>]
 *     downtrace init [--json]
 *     downtrace report [--json] <file>
 *     downtrace compare [--json] <base file> <change file>
 *     downtrace verify [--dsn <dsn> | --token <token> --url <url>]
 *     downtrace stamp [--commit <sha>]
 *
 * `login`, `brief`, `api` and `stamp` read their own words (`login/command.ts`, `read.ts`, `stamp.ts`); their usage is
 * here, with the rest.
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
  | { kind: "report"; json: boolean; file: string }
  | { kind: "compare"; json: boolean; base: string; change: string }
  | { kind: "verify"; dsn: string | undefined; token: string | undefined; url: string | undefined }
  | { kind: "error"; message: string };

export const USAGE = `Usage: downtrace check [options] [-- <test command>]
       downtrace init [--json]
       downtrace report [--json] <file>
       downtrace compare [--json] <base file> <change file>
       downtrace verify [--dsn <dsn> | --token <token> --url <url>]
       downtrace stamp [--commit <sha>]
       downtrace login --project <slug> [--env <environment>] [--level read|operate]   (downtrace login --help)
       downtrace brief [--project <slug>] [--since <instant>] [--url <cloud>] [--json]
       downtrace brief --deploy <version> [--wait <duration>] [--project <slug>] [--url <cloud>] [--json]
       downtrace api <path> [--url <cloud>] [--json]

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
downtrace.json with its test command, the instrumentation.ts a Next.js build with output "standalone" needs, and,
where @downtrace/agent is a dependency, the instrument file that starts it in production and the line that loads it.
It asks nothing and makes no network request. Run it again at any time: what is there already is kept.

Options of init:
  --json               print the result as JSON, for a coding agent

Exit status of init: 0 configured, 1 something could not be detected or done (it says what to do instead),
2 a file it reads could not be read, and nothing was written.

report reads a file DOWNTRACE_INSPECT wrote, and says for each route its requests, how many queries a request ran,
the operations a request ran more than once and the slowest ones: the routes with the most queries per request first.
It needs no account and no tests: start the application with DOWNTRACE_INSPECT=<file>, use it, and read the report.

compare reads two such files, a base and a change recorded however the project can, and judges them as check judges
its two runs: route by route, by composition, with the same verdicts and the same exit status.

Options of report and compare:
  --json               print the result as JSON, for a coding agent

Exit status of report: 0 reported, 2 the file could not be read as one DOWNTRACE_INSPECT wrote (it says which line).
Exit status of compare: the same as check's.

verify asks the cloud where a token writes, and says the project and the environment. It sends no data. The token
is the one the instrumentation would use, DOWNTRACE_DSN or DOWNTRACE_TOKEN and DOWNTRACE_URL, unless a flag gives
another; it is never printed.

Options of verify:
  --dsn <dsn>          the DSN to check, instead of the environment's
  --token <token>      the token to check, with --url, instead of the environment's
  --url <url>          the cloud to ask, with --token

Exit status of verify: 0 the token writes where it says, 1 the cloud refused the token, 2 nothing could be checked
(no token, a cloud that cannot be reached or does not answer in time, or any other answer; it says which).

stamp writes the commit the build is made from into .downtrace-version, in this directory, and the instrumentation
reports it as the deployed version when no variable names one. Run it in the build, beside the app's package.json.
The commit is --commit's, or git's HEAD, or the first CI variable that holds one (GITHUB_SHA,
CODEBUILD_RESOLVED_SOURCE_VERSION, CI_COMMIT_SHA, ...).

Options of stamp:
  --commit <sha>       the commit to write, 7 to 40 hexadecimal digits

Exit status of stamp: 0 written, 1 no commit was found and nothing was written, 2 a wrong option or a file that
could not be written.

brief reads a project's brief from the cloud: what a coding agent reads first. As text, its headline, what needs
attention and the command that reads each item's detail; with --json, the cloud's answer as it came. api reads one
path of a project's API, /api/p/<slug>/..., such as each item of a brief names, and prints the answer as it came. It
sends GET and nothing else: another method, another origin or a path outside a project's API is refused before
anything is sent. The credential is DOWNTRACE_TOKEN, unless it holds an ingestion token, which reads nothing;
otherwise the one downtrace login stored for the cloud and the project. It is never printed.

After a deploy, brief --deploy <version> --wait 10m reads that version's verdict until there is one: run it in the
background, and its exit status says whether the deploy broke something. While it waits it prints one line, on
stderr, and at the end a line for each environment that ran the version: its comparison's counts, or why it has none.

Options of brief and api:
  --project <slug>     brief: the project; default the only one downtrace login stored for the cloud (api reads
                       the project of its path)
  --since <instant>    brief: what counts as new, RFC 3339; default the last 24 hours
  --deploy <version>   brief: read the verdict of that deployed version, in each environment that ran it
  --wait <duration>    brief --deploy: read again, when the cloud says to, until there is a verdict or the duration
                       ends, 24h at most: 90s, 10m, 1h; default one read
  --url <cloud>        the cloud; default DOWNTRACE_URL, and without it Downtrace's cloud, as login's
  --json               brief: the cloud's answer as it came; both: a failure as JSON

Exit status of brief and api: 0 read, 1 the cloud refused (in its own words), 2 nothing could be read (no
credential, a path refused, a cloud that cannot be reached or does not answer in 30 s, or an answer that is not JSON).
Exit status of brief --deploy: 0 nothing got worse, 1 something did, 2 no verdict (no comparison by then, the version
did not appear, or nothing could be read; it says why, and a refusal of the cloud is 2).

  -h, --help           this text
  -v, --version        the version
`;

/** Reads what comes after `node downtrace`. */
export function parseArgs(argv: readonly string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined || first === "-h" || first === "--help" || first === "help") return { kind: "help" };
  if (first === "-v" || first === "--version" || first === "version") return { kind: "version" };
  if (first === "init") return parseInit(rest);
  if (first === "report" || first === "compare") return parseFiles(first, rest);
  if (first === "verify") return parseVerify(rest);
  if (first !== "check") {
    return {
      kind: "error",
      message: `unknown command "${first}": the ones there are are "check", "init", "report", "compare", "verify", "stamp", "login", "brief" and "api"`,
    };
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

/** Reads what comes after `downtrace verify`: a DSN, or a token and a URL, or nothing, and then the environment says. */
function parseVerify(rest: readonly string[]): Parsed {
  const given: { dsn?: string; token?: string; url?: string } = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    const [name = "", inline] = arg.startsWith("--") ? splitOnce(arg, "=") : [arg, undefined];
    if (name === "--dsn" || name === "--token" || name === "--url") {
      let value = inline;
      if (value === undefined) {
        i += 1;
        value = rest[i];
      }
      if (value === undefined || value === "") return { kind: "error", message: `${name} needs a value` };
      given[name.slice(2) as "dsn" | "token" | "url"] = value;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown option ${arg} for verify` };
    return { kind: "error", message: `unexpected "${arg}": verify reads the token from the environment or its flags` };
  }
  const { dsn, token, url } = given;
  if (dsn !== undefined && (token !== undefined || url !== undefined)) {
    return { kind: "error", message: "verify takes --dsn, or --token and --url, not both" };
  }
  if ((token === undefined) !== (url === undefined)) {
    return { kind: "error", message: "--token and --url go together: one names the token, the other the cloud" };
  }
  return { kind: "verify", dsn, token, url };
}

/** Reads what comes after `downtrace report` or `downtrace compare`: `--json`, and the files, one or two. */
function parseFiles(command: "report" | "compare", rest: readonly string[]): Parsed {
  let json = false;
  const files: string[] = [];
  for (const arg of rest) {
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--json") json = true;
    else if (arg.startsWith("-")) return { kind: "error", message: `unknown option ${arg} for ${command}` };
    else files.push(arg);
  }
  if (command === "report") {
    const [file] = files;
    if (file === undefined || files.length !== 1) {
      return { kind: "error", message: "report reads one file: downtrace report <file>" };
    }
    return { kind: "report", json, file };
  }
  const [base, change] = files;
  if (base === undefined || change === undefined || files.length !== 2) {
    return { kind: "error", message: "compare reads two files: downtrace compare <base file> <change file>" };
  }
  return { kind: "compare", json, base, change };
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}
