/**
 * `downtrace login`: a coding agent asks a Downtrace cloud for a project, one environment and a level of access, and
 * the person approves it once in the browser, the way `gh auth login` does (RFC 8628, the device authorization grant).
 * It prints a code and a link, waits for the approval, and prints what it received: an ingestion token for that
 * environment, which only sends data, and an access credential of that level, which reads that project and no other.
 *
 * It never sees the person's sign-in, and it writes nothing to disk: where the token and the credential are kept is the
 * person's choice, and the coding agent's.
 */

/**
 * Downtrace's cloud: the one `login` asks when neither `--url` nor `DOWNTRACE_URL` names another. This is the one place
 * the packages write its address; the usage takes it from here, and the documentation says «Downtrace's cloud». A
 * later domain would be a second name of the same cloud, and this address would keep serving.
 */
export const DOWNTRACE_CLOUD = "https://downtrace.uliber.com";

/** What the command needs from the process it runs in, passed in and not reached for. */
export interface LoginDeps {
  /** The words after `downtrace login`. */
  argv: readonly string[];
  /** The environment, read once at start-up: `DOWNTRACE_URL` when `--url` is not given, else Downtrace's cloud. */
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal: AbortSignal | undefined;
  /** The HTTP client; `fetch` unless a test stands one in. */
  fetchImpl?: typeof fetch;
  /** How the command waits between two asks; a real timer unless a test stands one in. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /**
   * The clock the code's life is measured with, in milliseconds: a duration, so `performance.now` unless a test
   * stands one in.
   */
  now?: () => number;
}

export const LOGIN_USAGE = `Usage: downtrace login --project <slug> [--env <environment>] [--level read|operate] [--name <name>]
                       [--rotate-token] [--url <cloud>] [--json]

login asks Downtrace's cloud, or the one --url names, for a project and connects a coding agent to it, with no
operator in between. It prints a link and a code; the person opens the link, signs in with GitHub and approves
once. Then it prints an access credential for that project, restricted to that one environment, and, when the
environment has no token yet, an ingestion token for it, which only sends data. An environment of the person's that
already has a token keeps it, and login prints only the credential, unless --rotate-token asks to replace it.

Options of login:
  --project <slug>     the project: lowercase letters, digits and dashes
  --env <environment>  the environment of the token and of the credential, and no other; default production
  --level <level>      what the access credential may do: read (default) or operate
  --name <name>        the project's name, when it is new; default the slug
  --rotate-token       for an environment that has an ingestion token, replace it too; the old one stops when this
                       one is collected
  --url <cloud>        the cloud, https:// (http:// only for localhost); default DOWNTRACE_URL, and without it
                       Downtrace's cloud, ${DOWNTRACE_CLOUD}
  --json               print the result as JSON, for a coding agent

Exit status of login: 0 approved, 1 not approved (denied, expired, full, unreachable), 2 a usage error.
`;

/** The shape of the JSON `--json` prints, versioned so a coding agent can tell a change in it. */
export const LOGIN_SCHEMA = "downtrace.login/1";

/** How long one request to the cloud may take. */
const REQUEST_TIMEOUT_MS = 15_000;
/** What RFC 8628 adds to the interval each time the cloud says to slow down. */
const SLOW_DOWN_SECONDS = 5;

interface LoginArgs {
  project: string;
  environment: string;
  level: string;
  name: string | undefined;
  rotateToken: boolean;
  url: string;
  json: boolean;
}

type ParsedLogin = { kind: "login"; args: LoginArgs } | { kind: "help" } | { kind: "error"; message: string };

/** Reads what comes after `downtrace login`. */
export function parseLoginArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedLogin {
  const values: Record<string, string | undefined> = {};
  let json = false;
  let rotateToken = false;
  const flags = new Set(["--project", "--env", "--level", "--name", "--url"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--rotate-token") {
      rotateToken = true;
      continue;
    }
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg];
    if (!flags.has(flag ?? "")) {
      return {
        kind: "error",
        message: arg.startsWith("-") ? `unknown option ${arg} for login` : `unexpected "${arg}"`,
      };
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") return { kind: "error", message: `${flag} needs a value` };
    values[flag ?? ""] = value;
  }
  const project = values["--project"];
  if (project === undefined) return { kind: "error", message: "--project is required: the project to connect to" };
  // A DOWNTRACE_URL set to nothing names no cloud; an empty --url is refused above.
  const url = (values["--url"] ?? env.DOWNTRACE_URL ?? "").trim().replace(/\/+$/, "") || DOWNTRACE_CLOUD;
  const reason = unusableUrl(url);
  if (reason !== undefined) return { kind: "error", message: reason };
  const level = values["--level"] ?? "read";
  if (level !== "read" && level !== "operate") {
    return { kind: "error", message: `--level is read or operate, not "${level}"` };
  }
  return {
    kind: "login",
    args: {
      project,
      environment: values["--env"] ?? "production",
      level,
      name: values["--name"],
      rotateToken,
      url,
      json,
    },
  };
}

/**
 * Why a cloud's address is not one to send a sign-up to, or undefined when it is: https://, or http:// to this machine
 * only, where nothing on the way can read what comes back.
 */
function unusableUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `the cloud's URL is not a URL: "${url}"`;
  }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) return undefined;
  if (parsed.protocol === "http:") {
    return `the cloud's URL must be https:// (http:// only for localhost), not "${url}": the credentials come back over it`;
  }
  return `the cloud's URL must be https://, not "${url}"`;
}

/** The hosts http:// is allowed to: this machine. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What the cloud handed over, as `--json` prints it. */
export interface LoginResult {
  schema: typeof LOGIN_SCHEMA;
  status: "approved";
  url: string;
  project: { slug: string; name: string };
  environment: string;
  /** The environment's ingestion token, or null when none was minted: the project existed and no rotation was asked. */
  ingestToken: string | null;
  /** The environment had a token, and this one replaced it. */
  replaced: boolean;
  accessCredential: {
    id: string;
    token: string;
    level: string;
    onBehalfOf: string;
    /** The environments it reaches. */
    environments: string[];
    /** When it stops opening anything, RFC 3339; empty when the cloud did not say. */
    expiresAt: string;
  };
}

/** Why it was not approved, as `--json` prints it. */
export interface LoginFailure {
  schema: typeof LOGIN_SCHEMA;
  status: "failed";
  /** The cloud's word for it (`access_denied`, `expired_token`…), or `unreachable`, `interrupted`, `bad-answer`. */
  reason: string;
  message: string;
}

/** Runs `downtrace login`, says the result and returns the exit status. */
export async function runLogin(deps: LoginDeps): Promise<number> {
  const parsed = parseLoginArgs(deps.argv, deps.env);
  if (parsed.kind === "help") {
    deps.stdout(LOGIN_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    deps.stderr(`downtrace login: ${parsed.message}\n\n${LOGIN_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  const outcome = await login(args, deps);
  if (outcome.status === "approved") {
    deps.stdout(args.json ? `${JSON.stringify(outcome, null, 2)}\n` : renderApproved(outcome));
    return 0;
  }
  if (args.json) deps.stdout(`${JSON.stringify(outcome, null, 2)}\n`);
  else deps.stderr(`downtrace login: ${outcome.message}\n`);
  return 1;
}

const fail = (reason: string, message: string): LoginFailure => ({
  schema: LOGIN_SCHEMA,
  status: "failed",
  reason,
  message,
});

/** The device flow: ask for a code, show it, and ask until the person decides or the code expires. */
async function login(args: LoginArgs, deps: LoginDeps): Promise<LoginResult | LoginFailure> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? (() => performance.now());
  const body: Record<string, string | boolean> = {
    project: args.project,
    environment: args.environment,
    level: args.level,
  };
  if (args.name !== undefined) body.name = args.name;
  if (args.rotateToken) body.rotate_token = true;
  // A refusal names the cloud it came from: with no --url, it is not one the person named.
  const cloud = `the cloud at ${new URL(args.url).origin}`;
  const asked = await post(fetchImpl, `${args.url}/login/device/code`, body, deps.signal);
  if ("failure" in asked) return asked.failure;
  if (asked.status !== 200) return refusal(asked.body, cloud, `${asked.status} to the request for a code`);
  const code = readCode(asked.body);
  if (code === undefined) return fail("bad-answer", "the cloud's answer to the request for a code is not one");
  // The page the person is sent to is the cloud's own: a link elsewhere is not one to follow.
  if (!sameOrigin(code.verificationUriComplete, args.url)) {
    return fail("bad-answer", `the cloud sent the person to another address than ${new URL(args.url).origin}`);
  }

  deps.stderr(
    `To approve, open ${code.verificationUriComplete} and check that it shows the code ${code.userCode}.\n` +
      `It asks for ${args.project}, environment ${args.environment}, level ${args.level}. ` +
      `Waiting for the approval; the code expires in ${Math.round(code.expiresIn / 60)} minutes.\n`,
  );

  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  while (now() < deadline) {
    try {
      await sleep(interval * 1000, deps.signal);
    } catch {
      return fail("interrupted", "interrupted before the approval");
    }
    const polled = await post(
      fetchImpl,
      `${args.url}/login/device/token`,
      { device_code: code.deviceCode },
      deps.signal,
    );
    if ("failure" in polled) {
      if (polled.failure.reason === "interrupted") return polled.failure;
      continue; // The network is the network: the next ask may get through, until the code expires.
    }
    if (polled.status === 200) {
      const delivered = readDelivery(polled.body, args.url);
      if (delivered === undefined)
        return fail("bad-answer", "the cloud's credentials are not in the shape this expects");
      // The instrumentation and the MCP server are pointed at this address: it is the cloud that was asked.
      if (!sameOrigin(delivered.url, args.url)) {
        return fail("bad-answer", `the cloud named another address than ${new URL(args.url).origin} to send to`);
      }
      return delivered;
    }
    if (polled.status === 429) {
      interval = Math.max(interval, polled.retryAfter ?? interval);
      continue;
    }
    if (polled.status >= 500) continue;
    const error = field(polled.body, "error");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += SLOW_DOWN_SECONDS;
      continue;
    }
    return refusal(polled.body, cloud, String(polled.status));
  }
  return fail("expired_token", "the code expired before it was approved: run downtrace login again");
}

/** A refusal of `cloud`, in its own words when it gave them, and otherwise what it `answered`. */
function refusal(body: unknown, cloud: string, answered: string): LoginFailure {
  const reason = field(body, "error") ?? "refused";
  const description = field(body, "error_description");
  return fail(reason, `${cloud} answered${description === undefined ? ` ${answered}` : `: ${description}`}`);
}

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

function readCode(body: unknown): DeviceCode | undefined {
  const deviceCode = field(body, "device_code");
  const userCode = field(body, "user_code");
  const uri = field(body, "verification_uri");
  const complete =
    field(body, "verification_uri_complete") ?? (uri === undefined ? undefined : `${uri}?code=${userCode}`);
  const expiresIn = number(body, "expires_in");
  const interval = number(body, "interval") ?? 5;
  if (deviceCode === undefined || userCode === undefined || complete === undefined || expiresIn === undefined) {
    return undefined;
  }
  return { deviceCode, userCode, verificationUriComplete: complete, expiresIn, interval: Math.max(1, interval) };
}

function readDelivery(body: unknown, askedUrl: string): LoginResult | undefined {
  const project = record(body, "project");
  const access = record(body, "access_credential");
  const slug = field(project, "slug");
  const environment = field(body, "environment");
  const id = field(access, "id");
  const token = field(access, "token");
  const level = field(access, "level");
  if ([slug, environment, id, token, level].some((v) => v === undefined)) return undefined;
  const environments = record(access, "environments");
  return {
    schema: LOGIN_SCHEMA,
    status: "approved",
    url: (field(body, "url") ?? askedUrl).replace(/\/+$/, ""),
    project: { slug: slug ?? "", name: field(project, "name") ?? slug ?? "" },
    environment: environment ?? "",
    ingestToken: field(body, "ingest_token") ?? null,
    replaced: record(body, "replaced") === true,
    accessCredential: {
      id: id ?? "",
      token: token ?? "",
      level: level ?? "",
      onBehalfOf: field(access, "on_behalf_of") ?? "",
      environments: Array.isArray(environments)
        ? environments.filter((e): e is string => typeof e === "string").map(printable)
        : [],
      expiresAt: field(access, "expires_at") ?? "",
    },
  };
}

/** Whether two addresses are the same scheme, host and port. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** What a person reads: what was granted, the two lines to paste, and what each one can do. */
export function renderApproved(r: LoginResult): string {
  const mcp = JSON.stringify(
    {
      mcpServers: {
        downtrace: {
          command: "npx",
          args: ["-y", "@downtrace/mcp"],
          env: { DOWNTRACE_URL: r.url, DOWNTRACE_TOKEN: r.accessCredential.token },
        },
      },
    },
    null,
    2,
  );
  const behalf = r.accessCredential.onBehalfOf === "" ? "" : `, on behalf of ${r.accessCredential.onBehalfOf}`;
  const expires = r.accessCredential.expiresAt === "" ? "" : ` It expires at ${r.accessCredential.expiresAt}.`;
  const reaches =
    r.accessCredential.environments.length === 0 ? "" : `, restricted to ${r.accessCredential.environments.join(", ")}`;
  const token =
    r.ingestToken === null
      ? [
          `No ingestion token: ${r.project.slug} existed, and the token of ${r.environment} stays as it is. To replace it,`,
          `run downtrace login --project ${r.project.slug} --env ${r.environment} --rotate-token.`,
        ]
      : [
          `The ingestion token for ${r.environment}. It only sends data, and reads nothing:`,
          `  DOWNTRACE_TOKEN=${r.ingestToken} DOWNTRACE_URL=${r.url}`,
          ...(r.replaced
            ? [`It replaced the token ${r.environment} had: batches sent with the old one are refused from now on.`]
            : []),
        ];
  return [
    `Approved: project ${r.project.slug}, environment ${r.environment}.`,
    "",
    ...token,
    "",
    `The access credential, level ${r.accessCredential.level}${behalf}, for ${r.project.slug}${reaches}.${expires}`,
    "Keep it where your coding agent keeps secrets. The MCP server's configuration with it:",
    mcp
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "",
    r.ingestToken === null ? "It is shown only once." : "Both are shown only once.",
    "",
  ].join("\n");
}

type Posted = { status: number; body: unknown; retryAfter: number | undefined } | { failure: LoginFailure };

/** One JSON request to the cloud, bounded in time, that never throws. */
async function post(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Posted> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      // The approval page shows the user agent, so the person can tell this request is the one they started.
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "downtrace-login" },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const retry = Number(res.headers.get("retry-after"));
    return { status: res.status, body: parsed, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined };
  } catch (err) {
    if (signal?.aborted === true) return { failure: fail("interrupted", "interrupted before the approval") };
    return {
      failure: fail(
        "unreachable",
        `the cloud at ${new URL(url).origin} did not answer: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function record(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

/** A string the cloud sent, with no control or bidirectional characters: what it says is printed to a terminal. */
function field(body: unknown, key: string): string | undefined {
  const value = record(body, key);
  if (typeof value !== "string") return undefined;
  const clean = printable(value);
  return clean === "" ? undefined : clean;
}

/** Drops the characters a terminal would act on rather than show: C0 and C1 controls and the bidirectional ones. */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it drops.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

function number(body: unknown, key: string): number | undefined {
  const value = record(body, key);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
