import { USAGE } from "./check/args.ts";
import { shellJoin } from "./check/config.ts";
import { printable, resolveCloud } from "./login/command.ts";
import { credentialsPath, readStoredCredential, type StoredCredential } from "./login/store.ts";
import { causeOf } from "./verify.ts";

/**
 * `downtrace brief` and `downtrace api`: a coding agent reads its project from the shell, where an MCP server is not
 * there yet —in Claude Code, one added during a session is there only in the next— or not at all, as in Codex, Cursor
 * or a CI job.
 *
 * `brief` reads the project's brief: what needs attention, each item with the path that has its detail. `api` reads
 * any such path, so the two read whatever the MCP server reads, with no command per tool. They only read: `api` sends
 * GET to the cloud configured, under a project's API, and refuses anything else before it sends anything. Operations
 * stay in the MCP server, which carries their idempotency keys. `brief --deploy` reads a deployed version's verdict,
 * and with `--wait` waits for it, so that a coding agent that just deployed leaves it running instead of reading the
 * brief each turn; its exit status is the verdict.
 *
 * The credential is `DOWNTRACE_TOKEN`, as the MCP server's is, unless it holds an ingestion token, which is what the
 * instrumentation reads from the same variable and reads nothing; otherwise the one `downtrace login` stored for the
 * cloud and the project, and no other. It is never printed.
 */

/** What `brief` and `api` need from the process they run in, passed in and not reached for. */
export interface ReadDeps {
  command: "brief" | "api";
  /** The words after the command. */
  argv: readonly string[];
  /** The environment, read once at start-up: `DOWNTRACE_TOKEN`, `DOWNTRACE_URL` and `XDG_CONFIG_HOME`. */
  env: NodeJS.ProcessEnv;
  /** The user's home directory: the credentials file is under its `.config` when `XDG_CONFIG_HOME` names none. */
  home: string;
  /** The user the credentials file must belong to; undefined where files have no POSIX owner. */
  uid: number | undefined;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal: AbortSignal | undefined;
  /** The HTTP client; `fetch` unless a test stands one in. */
  fetchImpl?: typeof fetch;
  /** How long the request may take, its body included; `READ_TIMEOUT_MS` unless a test says less. */
  timeoutMs?: number | undefined;
  /** The instant, in milliseconds since the epoch, a stored credential's expiry and a wait's deadline are read on. */
  now: () => number;
  /**
   * How `brief --wait` waits between two reads: a timer that the command's signal ends early, unless a test stands one
   * in. It never throws.
   */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/** The shape of a failure printed with `--json`, versioned so a coding agent can tell a change in it. */
export const READ_SCHEMA = "downtrace.read/1";

/** How long one request to the cloud may take, its body included. */
export const READ_TIMEOUT_MS = 30_000;

/**
 * How long `brief --wait` waits between two reads: what the cloud's `retryAfterSeconds` says, within these bounds, and
 * the default when it says nothing or the read failed. The longest `--wait` is the day of deploys the brief says.
 */
export const WAIT_BOUNDS = { minMs: 5_000, maxMs: 300_000, defaultMs: 60_000, longestMs: 24 * 3_600_000 };

/** What starts an ingestion token: it only sends, and the cloud's every read answers it as no credential at all. */
const INGEST_PREFIX = "dt_";

/** A segment a path may carry as written: RFC 3986's characters of a path segment, escapes among them. */
const SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/;
/** A project's slug, written in a path with no escape to read. */
const SLUG = /^[A-Za-z0-9._~-]+$/;

interface ReadArgs {
  /** `api`: the path or URL as given. */
  path: string | undefined;
  /** `brief`: `--project`. */
  project: string | undefined;
  /** `brief`: `--since`, as given: the cloud says what it takes. */
  since: string | undefined;
  /** `brief`: `--deploy`, the version whose verdict is read, as given: the cloud says what it takes. */
  deploy: string | undefined;
  /** `brief`: `--wait`, in milliseconds; 0 when not given, which is one read. */
  waitMs: number;
  url: string | undefined;
  json: boolean;
}

type Parsed = { kind: "read"; args: ReadArgs } | { kind: "help" } | { kind: "error"; message: string };

/** Reads what comes after `downtrace brief` or `downtrace api`. Neither takes a method: `api` sends GET alone. */
export function parseReadArgs(command: "brief" | "api", argv: readonly string[]): Parsed {
  const values: Record<string, string> = {};
  const words: string[] = [];
  let json = false;
  const flags = command === "brief" ? ["--project", "--since", "--deploy", "--wait", "--url"] : ["--url"];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--json") json = true;
    else if (!arg.startsWith("-")) words.push(arg);
    else {
      const at = arg.indexOf("=");
      const flag = at === -1 ? arg : arg.slice(0, at);
      if (!flags.includes(flag)) return { kind: "error", message: `unknown option ${arg} for ${command}` };
      const value = at === -1 ? argv[++i] : arg.slice(at + 1);
      if (value === undefined || value === "") return { kind: "error", message: `${flag} needs a value` };
      values[flag] = value;
    }
  }
  const wait = values["--wait"] === undefined ? 0 : durationMs(values["--wait"]);
  const args: ReadArgs = {
    path: undefined,
    project: values["--project"],
    since: values["--since"],
    deploy: values["--deploy"],
    waitMs: wait ?? 0,
    url: values["--url"],
    json,
  };
  if (command === "brief") {
    if (words.length > 0)
      return { kind: "error", message: `unexpected "${words[0]}": brief reads the project --project names` };
    if (args.project !== undefined && !isSlug(args.project)) {
      return { kind: "error", message: `--project is not a project's slug: ${JSON.stringify(args.project)}` };
    }
    if (wait === undefined || wait > WAIT_BOUNDS.longestMs) {
      return {
        kind: "error",
        message: `--wait is a duration of 24 hours at most, such as 90s, 10m or 1h: ${JSON.stringify(printable(values["--wait"] ?? ""))}`,
      };
    }
    if (values["--wait"] !== undefined && args.deploy === undefined) {
      return { kind: "error", message: "--wait waits for a deploy's verdict: name its version with --deploy" };
    }
    return { kind: "read", args };
  }
  if (words.length !== 1) return { kind: "error", message: "api reads one path: downtrace api /api/p/<slug>/<what>" };
  return { kind: "read", args: { ...args, path: words[0] } };
}

/** A duration as `--wait` takes it, in milliseconds: whole seconds, minutes or hours, seconds with no unit. */
function durationMs(text: string): number | undefined {
  const match = /^(\d{1,6})([smh]?)$/.exec(text);
  if (match === null) return undefined;
  return Number(match[1]) * { "": 1_000, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "" | "s" | "m" | "h"];
}

/** A failure: what went wrong, said in a line, and the cloud's status when it was the cloud that refused. */
interface Failure {
  reason: string;
  message: string;
  httpStatus?: number;
}

const fail = (reason: string, message: string): Failure => ({ reason, message });

/** Runs `downtrace brief` or `downtrace api`, says the result and returns the exit status. */
export async function runRead(deps: ReadDeps): Promise<number> {
  const parsed = parseReadArgs(deps.command, deps.argv);
  if (parsed.kind === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  const usage = (message: string): number => {
    deps.stderr(`downtrace ${deps.command}: ${message}\n\n${USAGE}`);
    return 2;
  };
  if (parsed.kind === "error") return usage(parsed.message);
  const { args } = parsed;
  const cloud = resolveCloud(args.url, deps.env);
  if ("reason" in cloud) return usage(cloud.reason);
  const said = (failure: Failure): number => {
    if (args.json) deps.stdout(`${JSON.stringify({ schema: READ_SCHEMA, status: "failed", ...failure }, null, 2)}\n`);
    else deps.stderr(`downtrace ${deps.command}: ${failure.message}\n`);
    // With --deploy, 1 is the verdict `worse` and nothing else: a refusal is one more way of having no verdict.
    return failure.reason === "refused" && args.deploy === undefined ? 1 : 2;
  };

  const asked = args.path === undefined ? undefined : apiPath(args.path, cloud.url);
  if (asked !== undefined && "reason" in asked) return said(fail("refused-path", asked.reason));
  const credential = await credentialFor(cloud.url, asked?.project ?? args.project, deps);
  if ("reason" in credential) return said(credential);
  const { project } = credential;
  const query = Object.entries({ since: args.since, deploy: args.deploy })
    .flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`]))
    .join("&");
  // The brief's path is read as `api` reads any: a slug from the credentials file is held to the same rules.
  const target = asked ?? apiPath(`/api/p/${project}/brief${query === "" ? "" : `?${query}`}`, cloud.url);
  if ("reason" in target) return said(fail("refused-path", target.reason));
  const url = `${cloud.url}${target.path}`;
  if (args.deploy !== undefined) {
    const waiting = { url, cloud: cloud.url, project, version: args.deploy, waitMs: args.waitMs, json: args.json };
    return waitForVerdict(waiting, credential, said, deps);
  }

  const got = await readAnswer(url, credential, cloud.url, deps);
  if ("reason" in got) return said(got);
  if (deps.command === "api" || args.json) deps.stdout(withNewline(got.text));
  else deps.stdout(renderBrief(got.body, project));
  return 0;
}

const withNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

type Answered = { text: string; body: unknown };

/** One read of the cloud: its answer as it came and as JSON, or why there is none. It never throws. */
async function readAnswer(
  url: string,
  credential: Credential,
  cloud: string,
  deps: ReadDeps,
): Promise<Answered | Failure> {
  const origin = new URL(cloud).origin;
  const got = await get(url, credential.token, deps);
  if ("reason" in got) return got;
  const { status, text } = got;
  if (status >= 300 && status < 400) {
    const to = got.location === null ? "" : ` to ${JSON.stringify(printable(got.location))}`;
    return fail(
      "bad-answer",
      `the cloud at ${origin} answered ${status}, a redirect${to}, which is not followed: the credential goes to that cloud alone`,
    );
  }
  if (status >= 400 && status < 500) {
    const message = `the cloud at ${origin} answered ${status}: ${wordsOf(text)}${status === 401 ? notTaken(credential, cloud) : ""}`;
    return { reason: "refused", httpStatus: status, message };
  }
  if (status < 200 || status >= 300)
    return fail("cloud-error", `the cloud at ${origin} answered ${status}: ${wordsOf(text)}`);
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    return fail("bad-answer", `the cloud at ${origin} answered ${status} with something that is not JSON`);
  }
}

/** What `brief --deploy` waits for: the brief's address, whose project and version, how long, and how it prints. */
interface Waiting {
  url: string;
  cloud: string;
  project: string;
  version: string;
  waitMs: number;
  json: boolean;
}

/** The exit status of each verdict the cloud says: only `worse` is 1, and only `unchanged` is 0 (invariant 14). */
const EXIT_OF = { worse: 1, unchanged: 0, pending: 2, none: 2 } as const;
type Verdict = keyof typeof EXIT_OF;

/** The failures a later read may not have: the cloud was slow, unreachable or failing. Any other ends the wait. */
const PASSING = new Set(["timeout", "unreachable", "cloud-error"]);

/**
 * `brief --deploy <version> [--wait <duration>]`: reads the brief for that version until its verdict is not
 * `pending`, or the duration ends, waiting between reads what the cloud's `retryAfterSeconds` says within
 * `WAIT_BOUNDS`, and the last wait no further than the deadline. The credential is looked up again before each read,
 * so an expired one is not sent, and one login renewed meanwhile is. While it waits it prints one line, on stderr; at
 * the end, the verdict, or why there is none.
 */
async function waitForVerdict(
  w: Waiting,
  first: Credential,
  said: (failure: Failure) => number,
  deps: ReadDeps,
): Promise<number> {
  const sleep = deps.sleep ?? sleepFor;
  const deadline = deps.now() + w.waitMs;
  const by = instantOf(deadline);
  const version = JSON.stringify(printable(w.version));
  const origin = new URL(w.cloud).origin;
  if (w.waitMs > 0) {
    deps.stderr(`downtrace ${deps.command}: waiting until ${by} for the verdict of ${version} in ${w.project}\n`);
  }
  let credential: Credential | Failure = first;
  for (;;) {
    if ("reason" in credential) return said(credential);
    const got = await readAnswer(w.url, credential, w.cloud, deps);
    // What this read left to say if the deadline comes now: the pending verdict, or the failure that passes.
    let last: { answered: Answered; deploy: unknown } | Failure;
    let waitMs = WAIT_BOUNDS.defaultMs;
    if ("reason" in got) {
      if (!PASSING.has(got.reason)) return said(got);
      last = got;
    } else {
      const deploy = memberOf(got.body, "deploy");
      const verdict = memberOf(deploy, "verdict");
      if (deploy === undefined) {
        return said(
          fail("bad-answer", `the cloud at ${origin} says no verdict of ${version}: it is older than this command`),
        );
      }
      if (typeof verdict !== "string" || !Object.hasOwn(EXIT_OF, verdict)) {
        const named = JSON.stringify(printable(String(verdict)));
        return said(fail("bad-answer", `the cloud at ${origin} says a verdict this command does not know: ${named}`));
      }
      if (verdict !== "pending") return sayVerdict(w, got, deploy, verdict as Verdict, undefined, deps);
      last = { answered: got, deploy };
      const retry = memberOf(deploy, "retryAfterSeconds");
      if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) {
        waitMs = Math.min(Math.max(retry * 1000, WAIT_BOUNDS.minMs), WAIT_BOUNDS.maxMs);
      }
    }
    const left = deadline - deps.now();
    if (left <= 0) {
      if ("reason" in last) return said({ ...last, message: `no verdict of ${version} by ${by}: ${last.message}` });
      return sayVerdict(w, last.answered, last.deploy, "pending", by, deps);
    }
    await sleep(Math.min(waitMs, left), deps.signal);
    if (deps.signal?.aborted === true) {
      return said(fail("interrupted", `interrupted while waiting for the verdict of ${version}`));
    }
    credential = await credentialFor(w.cloud, w.project, deps);
  }
}

/** Prints a verdict: the cloud's answer as it came with --json, else a line for each environment. */
function sayVerdict(
  w: Waiting,
  answered: Answered,
  deploy: unknown,
  verdict: Verdict,
  by: string | undefined,
  deps: ReadDeps,
): number {
  deps.stdout(w.json ? withNewline(answered.text) : renderVerdict(deploy, w.project, by));
  return EXIT_OF[verdict];
}

/** A wait that ends at `ms`, or when the signal aborts; it never throws, and leaves no timer behind. */
export function sleepFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** An instant to the second, as RFC 3339 in UTC. */
function instantOf(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * A deploy's verdict as text: one line for each environment that ran it, its comparison's counts or why it has none,
 * and the command that reads the rows of one that got worse. A deadline that came first is said last. As the brief's
 * text, what is not there is left out and the cloud's sentences are printed without what a terminal acts on.
 */
export function renderVerdict(deploy: unknown, project: string, by?: string): string {
  const version = textOf(deploy, "version") ?? "";
  const environments = memberOf(deploy, "environments");
  const listed = memberOf(environments, "items");
  const items = Array.isArray(listed) ? listed : [];
  const says = textOf(deploy, "says");
  const lines: string[] = [];
  for (const item of items) {
    const d = memberOf(item, "deploy");
    const name = [project, textOf(d, "environment"), textOf(d, "version") ?? version].filter(Boolean).join(" ");
    const counts = countsOf(memberOf(d, "comparison"));
    const why = textOf(item, "says");
    const verdict = textOf(d, "verdict");
    if (counts === undefined) lines.push(`${name}: no comparison${why === undefined ? "" : `: ${why}`}`);
    else lines.push(`${name}: ${counts}${verdict === "pending" && why !== undefined ? `; ${why}` : ""}`);
    const read = readOf(item);
    if (verdict === "worse" && read !== undefined) lines.push(`  its rows: ${read}`);
  }
  const total = memberOf(environments, "total");
  if (typeof total === "number" && total > items.length) {
    lines.push(
      `… and ${total - items.length} more environment(s): downtrace brief --project ${project} --deploy ${shellJoin([version])} --json`,
    );
  }
  if (items.length === 0)
    lines.push(`${[project, version].filter(Boolean).join(" ")}: ${says ?? "no environment said"}`);
  if (by !== undefined) lines.push(`No verdict by ${by}${items.length > 0 && says !== undefined ? `: ${says}` : "."}`);
  return `${lines.join("\n")}\n`;
}

/** A comparison's counts in a line, or undefined when there is no comparison to count. */
function countsOf(comparison: unknown): string | undefined {
  const [rows, worse, unevaluable] = ["rows", "worse", "unevaluable"].map((key) => memberOf(comparison, key));
  if (typeof rows !== "number" || typeof worse !== "number" || typeof unevaluable !== "number") return undefined;
  return `${worse} ${worse === 1 ? "row" : "rows"} worse, ${rows - worse - unevaluable} unchanged, ${unevaluable} not evaluated`;
}

/**
 * The path `api` reads, as the cloud's path under its URL with the query given, and the project it is of; or why it
 * is not one to send a credential to. It is a path under `/api/p/<slug>/`, or the same on the configured cloud's URL.
 * It is read as written: a segment that is `.` or `..`, or that hides a separator in an escape (`%2e%2e`, `%2f`,
 * `%5c`), is refused and never resolved, so that what is checked is what the cloud is sent.
 */
function apiPath(given: string, cloud: string): { path: string; project: string } | { reason: string } {
  const shown = JSON.stringify(printable(given));
  const base = new URL(cloud);
  const under = base.pathname.replace(/\/+$/, "");
  const outside = { reason: `${shown} is not a path under /api/p/<slug>/ of the cloud at ${base.origin}` };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it refuses.
  if (/[\s\u0000-\u001f\u007f#\\]/.test(given)) {
    return {
      reason: `${shown} has a space, a control character, a backslash or a fragment, which a path to read has not`,
    };
  }
  let path = given;
  if (/^[a-z][a-z0-9+.-]*:/i.test(given)) {
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      return { reason: `${shown} is not a URL` };
    }
    if (url.origin !== base.origin || url.username !== "" || url.password !== "") {
      return { reason: `${shown} is not on the cloud at ${base.origin}: the credential goes to that cloud alone` };
    }
    // The path as written, from the end of the authority: the parsed one has its dot segments resolved already.
    const rest = given.slice(given.indexOf("//") + 2);
    const at = rest.search(/[/?]/);
    path = at === -1 ? "" : rest.slice(at);
    if (!path.startsWith(`${under}/`)) return outside;
    path = path.slice(under.length);
  }
  const query = path.indexOf("?");
  const segments = (query === -1 ? path : path.slice(0, query)).split("/");
  const [empty, api, p, slug, ...rest] = segments;
  if (empty !== "" || api !== "api" || p !== "p" || slug === undefined || rest.length === 0) return outside;
  for (const segment of segments.slice(3)) {
    if (!SEGMENT.test(segment)) return outside;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { reason: `${shown} has an escape that is not one` };
    }
    if (decoded === "." || decoded === ".." || /[/\\?#]/.test(decoded)) {
      return {
        reason: `${shown} has a segment that is . or .., or a separator in an escape, which is not resolved: api reads a path as written`,
      };
    }
  }
  if (!isSlug(slug)) return outside;
  // What the cloud is sent is what was checked: the URL keeps the path as it was given.
  const sent = new URL(`${cloud}${path}`);
  if (sent.origin !== base.origin || sent.pathname !== `${under}${segments.join("/")}`) return outside;
  return { path, project: slug };
}

function isSlug(text: string): boolean {
  return SLUG.test(text) && text !== "." && text !== "..";
}

type Credential = { token: string; project: string; stored: StoredCredential | undefined };

/**
 * The credential to send for `project` at `cloud`, and the project it reads: `DOWNTRACE_TOKEN`, or the one login
 * stored for the pair; with no project named, the only one stored for the cloud. An expired entry is not sent, and
 * neither is anything from a file that is not used: the failure says why, and what to run.
 */
async function credentialFor(
  cloud: string,
  project: string | undefined,
  deps: ReadDeps,
): Promise<Credential | Failure> {
  const variable = (deps.env.DOWNTRACE_TOKEN ?? "").trim();
  const ingest = variable.startsWith(INGEST_PREFIX);
  const fromEnv = variable !== "" && !ingest;
  if (fromEnv && project !== undefined) return { token: variable, project, stored: undefined };
  const lookup = await readStoredCredential(
    { url: cloud, project },
    { path: credentialsPath(deps.env, deps.home), uid: deps.uid, now: deps.now() },
  );
  const projects = lookup.kind === "missing" || lookup.kind === "ambiguous" ? lookup.projects.map(printable) : [];
  if (fromEnv) {
    // The variable is what is sent; the file is read only for the project it is of, which the variable does not say.
    if (lookup.kind === "found" || lookup.kind === "expired") {
      return { token: variable, project: lookup.credential.project, stored: undefined };
    }
    const why =
      lookup.kind === "unusable"
        ? `the credentials downtrace login stored are not used: ${lookup.reason}`
        : lookup.kind === "ambiguous"
          ? `downtrace login stored credentials of several projects at ${cloud}: ${projects.join(", ")}`
          : `downtrace login stored none at ${cloud} to take it from`;
    return fail("no-project", `name the project with --project: DOWNTRACE_TOKEN does not say which it is, and ${why}`);
  }
  const before = ingest
    ? "DOWNTRACE_TOKEN is an ingestion token, which reads nothing, so it is not sent; and "
    : "there is no DOWNTRACE_TOKEN, and ";
  switch (lookup.kind) {
    case "found":
      return { token: lookup.credential.token, project: lookup.credential.project, stored: lookup.credential };
    case "expired": {
      const c = lookup.credential;
      return fail(
        "expired-credential",
        `${before}the credential downtrace login stored for ${printable(c.project)} at ${cloud} expired at ` +
          `${printable(c.expiresAt)}, so it was not sent: run \`${loginCommand(c, cloud)}\` again`,
      );
    }
    case "missing": {
      const others = projects.length === 0 ? "" : ` (it stored ones of ${projects.join(", ")})`;
      const login = loginCommand({ project: project ?? "<slug>", environment: "", level: "" }, cloud);
      return fail(
        "no-credential",
        `${before}downtrace login stored no credential for ${project ?? "a project"} at ${cloud}${others}: run \`${login}\``,
      );
    }
    case "ambiguous":
      return fail(
        "no-project",
        `${before}downtrace login stored credentials of several projects at ${cloud}: ${projects.join(", ")}; name one with --project`,
      );
    case "unusable":
      return fail(
        "unusable-credentials",
        `${before}the credentials downtrace login stored are not used: ${lookup.reason}`,
      );
  }
}

/** The login that stores a credential for `cloud`: of the project, with the environment and level given. */
function loginCommand(c: Pick<StoredCredential, "project" | "environment" | "level">, cloud: string): string {
  const env = c.environment === "" ? [] : ["--env", printable(c.environment)];
  const level = c.level === "" ? [] : ["--level", printable(c.level)];
  return shellJoin([
    "npx",
    "@downtrace/agent",
    "login",
    "--project",
    printable(c.project),
    ...env,
    ...level,
    "--url",
    cloud,
  ]);
}

/** What a 401 says of the credential sent, which the cloud does not take: expired, revoked or never one. */
function notTaken(credential: Credential, cloud: string): string {
  if (credential.stored === undefined) return "; DOWNTRACE_TOKEN is expired, revoked or unknown to it";
  return (
    `; the credential downtrace login stored for ${printable(credential.project)} is expired, revoked or unknown to ` +
    `it: run \`${loginCommand(credential.stored, cloud)}\` for another`
  );
}

/** What the cloud said, in its own words: its `error` when it answered one, else its text, in a line. */
function wordsOf(text: string): string {
  let words = text;
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
      words = (body as { error: string }).error;
    }
  } catch {
    // Not JSON: the text is what it said.
  }
  const line = printable(words.replace(/\s+/g, " ")).trim();
  if (line === "") return "it gave no reason";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

type Got = { status: number; text: string; location: string | null };

/** One GET to the cloud with the credential, bounded in time, that never throws. A redirect is not followed. */
async function get(url: string, token: string, deps: ReadDeps): Promise<Got | Failure> {
  const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS;
  const origin = new URL(url).origin;
  // One deadline for the request and its body, and the command's own signal on top of it. By hand rather than with
  // `AbortSignal.any`, which Node 20 has only from 20.3, as `verify` does.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const interrupt = (): void => controller.abort();
  deps.signal?.addEventListener("abort", interrupt, { once: true });
  if (deps.signal?.aborted === true) controller.abort();
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": `downtrace-${deps.command}`,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text(), location: res.headers.get("location") };
  } catch (err) {
    if (timedOut) return fail("timeout", `the cloud at ${origin} did not answer within ${timeoutMs / 1000} s`);
    if (deps.signal?.aborted === true) return fail("interrupted", "interrupted before the cloud answered");
    return fail("unreachable", `could not reach the cloud at ${origin}: ${causeOf(err)}`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", interrupt);
  }
}

/**
 * The brief as text: its headline, what needs attention with the command that reads each item's detail, and the read
 * that follows. What is not there is left out, never guessed, so a brief of a later cloud, or one the cloud cut, still
 * prints. The sentences are Downtrace's own, printed without the characters a terminal would act on; an item's id is
 * the cloud's name for it, and is printed quoted, as data. What the service sent, under `fromService`, is not printed.
 */
export function renderBrief(brief: unknown, project: string): string {
  const headline = textOf(brief, "headline");
  const lines = [headline === undefined ? `Brief of ${project}.` : `${project}: ${headline}`];
  const attention = memberOf(brief, "attention");
  const items = Array.isArray(attention) ? attention : memberOf(attention, "items");
  if (Array.isArray(items)) {
    const total = memberOf(attention, "total");
    const of = typeof total === "number" && total > items.length ? ` (${items.length} of ${total})` : "";
    lines.push("", items.length === 0 ? "Needs attention: nothing listed in this brief." : `Needs attention${of}:`);
    for (const item of items) {
      const id = textOf(item, "id");
      const says = textOf(item, "says");
      lines.push(
        `  ${textOf(item, "kind") ?? "item"}${id === undefined ? "" : ` ${JSON.stringify(id)}`}${says === undefined ? "" : `: ${says}`}`,
      );
      const read = readOf(item);
      if (read !== undefined) lines.push(`    ${read}`);
    }
  }
  const next = readOf(brief);
  if (next !== undefined) lines.push("", `Next: ${next}`);
  lines.push(`Routes, hotspots, telemetry and what the brief cannot say: downtrace brief --project ${project} --json`);
  return `${lines.join("\n")}\n`;
}

/** The command that reads what `holder.next` points at, or undefined when it points at nothing. */
function readOf(holder: unknown): string | undefined {
  const api = textOf(memberOf(holder, "next"), "api");
  return api === undefined ? undefined : `downtrace api ${shellJoin([api])}`;
}

function memberOf(holder: unknown, key: string): unknown {
  return typeof holder === "object" && holder !== null && !Array.isArray(holder)
    ? (holder as Record<string, unknown>)[key]
    : undefined;
}

/** A string the cloud sent, printable, or undefined when there is none. */
function textOf(holder: unknown, key: string): string | undefined {
  const value = memberOf(holder, key);
  const text = typeof value === "string" ? printable(value).trim() : "";
  return text === "" ? undefined : text;
}
