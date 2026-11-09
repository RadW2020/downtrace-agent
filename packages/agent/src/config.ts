import { isAbsolute } from "node:path";
import { preservesSymlinksMain } from "./entry.ts";
import { patternsOf } from "./exclude.ts";
import { Sheddable, type SheddableLevel } from "./overhead.ts";
import { PROFILE_WINDOW_MS } from "./profile.ts";

export interface AgentConfig {
  token: string;
  /** Ingest base URL, without trailing slash. */
  url: string;
  environment: string;
  /**
   * The deployed version a variable names (`VERSION_ENV_VARS`), or `unknown`. When it is `unknown`, the start-up looks
   * further: the runtime's metadata, then a fingerprint of the code (`deployed.ts`, DT-130).
   */
  version: string;
  /** The variable `version` was read from; absent when none named it. Said by the line `DOWNTRACE_DEBUG` writes. */
  versionFrom?: string | undefined;
  /**
   * The ECS task metadata endpoint of this container, which the ECS agent sets in every container it starts
   * (`ECS_CONTAINER_METADATA_URI_V4`, or the v3 one on an older agent). Asked once, at start-up, for the digest of the
   * image, and only when no variable named the version (DT-130). Absent anywhere but on ECS.
   */
  ecsMetadataUri?: string | undefined;
  debug: boolean;
  /** Aggregation interval; 10 s in production. */
  intervalMs: number;
  /**
   * How long a profile window stays open; one minute in production, the cadence ADR 0017 fixed and which this
   * does not move. It is a setting for the same reason the interval above is one: what cannot be accelerated
   * cannot be tested end to end, and the profile is what the report's diff compares (gh-565).
   *
   * Never below `intervalMs`. The profile rotates on each flush, so a window shorter than the interval that
   * feeds it closes on the very same flush as one equal to it — below that the number stops meaning anything.
   *
   * Never above `profileCeilingMs(intervalMs)` either. The report's diff reads the recent window as the last
   * five minutes, ending one minute ago, and it counts a profile on the side where it starts; a window that
   * starts at s is in the store by the check only once it has closed, which is the first flush after
   * s + profileMs. Above the ceiling, phases exist in which the report's window holds no profile that has
   * arrived, and the report says `no-profile-after` of a route that was profiled as asked (gh-716).
   */
  profileMs: number;
  /** Which observers are on. `DOWNTRACE_INSTRUMENT` takes `all`, `none`, or a list like `pg,http`. */
  instrument: ReadonlySet<Instrument>;
  /**
   * Where to write every batch exactly as it would be sent, or nothing. `stderr` or a path. With it set, the
   * token and the URL become optional: the point is to be able to look before trusting anyone (gh-181).
   */
  inspect: string | undefined;
  /**
   * Where to write the routes the application declares, or nothing: `DOWNTRACE_CHECK_ROUTES`, which only
   * `downtrace check` sets, beside the inspection file of its run. A route no test calls leaves nothing in the
   * batches, and this is how the comparison can still name it (ESC-18). Absent, the walk is never made.
   */
  checkRoutes: string | undefined;
  /**
   * The directory of the project `downtrace check` runs the tests of: `DOWNTRACE_CHECK_PROJECT`, which only `check`
   * sets. The application's modules resolve from it as well as from the entry, which under a suite is the runner
   * (`resolutionBases`). Absent, or not an absolute path, they resolve from the entry alone.
   */
  checkProject: string | undefined;
  /**
   * Where to write the places in the project where the application ran its operations, or nothing:
   * `DOWNTRACE_CHECK_SITES`, which only `check` sets, for the run of the change (RF-526). Absent, no stack is taken.
   */
  checkSites: string | undefined;
  /**
   * Whether the normalised query text travels with the profile. `DOWNTRACE_QUERY_TEXT=off` suppresses it and
   * changes nothing else: the hash is the identity, so the analysis stays whole (ADR 0017, invariant 5).
   */
  queryText: boolean;
  /**
   * Route templates the operator asked not to be looked at, and dependency targets likewise
   * (`DOWNTRACE_EXCLUDE_ENDPOINTS`, `DOWNTRACE_EXCLUDE_DEPENDENCIES`). `product.md:104` gives them this,
   * and excluding means **not observing**: what the cloud is told is how many are missing, not which
   * (ADR 0101, gh-361).
   */
  excludeEndpoints: readonly string[];
  excludeDependencies: readonly string[];
  /**
   * `DOWNTRACE_MINIMAL=1`: no free text leaves the server. Routes, dependency targets, the hostname and
   * the deployed version travel as stable digests of themselves; query text, error messages and exception
   * signatures do not travel at all (`product.md:104`, ADR 0105).
   */
  minimal: boolean;
  /**
   * The least the instrumentation gives up, whatever its own meter measures: `nothing`, `fine` or `profile`
   * (ADR 0080). The benchmark's switch for weighing each half of the black box on its own (gh-570); an operator
   * leaves it alone.
   */
  shed: SheddableLevel;
  /**
   * How much of the Postgres observer's attribution runs: `full` (the default) is the observer as it is;
   * `context` records the calls and the waits against the request and never looks at the query text; `wrapper`
   * only leaves the patch in place, and the wrapper runs and records nothing. The benchmark's switch for
   * weighing the observer part by part (gh-592); an operator leaves it alone, and it moves no budget — the
   * arithmetic of ADR 0067 is about the registers, and no level touches one.
   */
  pgDepth: PgDepth;
  /**
   * Whether Node keeps the main module's symlinks: `--preserve-symlinks-main`, on the command line or in
   * `NODE_OPTIONS`. Not a setting of the instrumentation but of the process it runs in, read here because this
   * is where the environment is read: `pg` and Express are resolved from where Node runs the application, which
   * is the realpath of its entry unless this says otherwise (DT-34).
   */
  preserveSymlinksMain: boolean;
}

/**
 * The result of reading the environment once, at start-up. `warnings` is what the start-up says about a value
 * it did not take as given: the operator's number stays visible, and so does what happened to it.
 */
export type ConfigResult = { ok: true; config: AgentConfig; warnings: string[] } | { ok: false; reason: string };

/** Everything the agent can observe, each switchable on its own so its cost can be measured on its own. */
export const INSTRUMENTS = ["pg", "mysql", "sqlite", "mssql", "mongodb", "prisma", "http", "redis", "runtime"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

/** How much of the Postgres observer's attribution runs; see `AgentConfig.pgDepth`. */
export type PgDepth = "wrapper" | "context" | "full";

export const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;

/**
 * The ceiling on `profileMs`, as a function of the interval. Derived, not chosen, the way the floor is
 * (gh-716):
 *
 * - The report's diff reads the recent window as the last five minutes, ending one minute ago. The five
 *   minutes and the minute live in the cloud, in the detector's geometry; this package does not import them,
 *   it states the arithmetic it is derived against, and a test pins it.
 * - The one minute is the arrival budget: what is flushed by then has arrived by the check.
 * - A profile window is counted on the side where it **starts**, and a window that starts at s has arrived
 *   by the check only once it has closed and was flushed at least a minute earlier. It closes on the first
 *   flush after s + profileMs, at most one interval later, so the starts a check can still read lie in a
 *   span of five minutes minus profileMs minus intervalMs.
 * - Starts come one per closed window, spaced at most profileMs + intervalMs apart. For at least one to
 *   fall in that span at **every** phase, the span must hold one whole period of the starts:
 *
 *   5 * 60_000 − profileMs − intervalMs ≥ profileMs + intervalMs
 *   profileMs ≤ 5 * 60_000 / 2 − intervalMs
 *
 * Above the ceiling, a phase exists in which the report's window holds no profile that has arrived, whatever
 * the instrumentation is sent, and the report says `no-profile-after` of a route that was profiled as asked.
 *
 * The `max` with the interval guards the arithmetic, not a preference: when the interval is so long that two
 * windows with their two flushes no longer fit in the five minutes at all, the ceiling would go under the
 * floor, and the floor — where the number stops meaning anything — is the answer.
 */
export function profileCeilingMs(intervalMs: number): number {
  return Math.max(intervalMs, (5 * 60_000) / 2 - intervalMs);
}

/**
 * The variables the deployed version is read from, in order of preference: the first with a value names it (DT-130).
 *
 * The operator's own first. Then the commit a deploy platform sets in the running application. Then the commit a CI
 * service or a build sets: those exist in the build, and reach the application only when the build passes them on
 * (`ARG`/`ENV` in a Dockerfile, an `.env` it writes), which is common enough to read them. Last, what a platform
 * names a deploy by when it sets no commit at all: those are not commits, and each reads as what it is. Each one was
 * checked against its platform's documentation when it was added. A name that two platforms share is listed once.
 */
export const VERSION_ENV_VARS = [
  "DOWNTRACE_VERSION",
  "APP_VERSION",
  "GIT_SHA",
  // Deploy platforms, in the running application.
  "VERCEL_GIT_COMMIT_SHA", // Vercel
  "HEROKU_BUILD_COMMIT", // Heroku, dyno metadata
  "HEROKU_SLUG_COMMIT", // Heroku, dyno metadata, the name before HEROKU_BUILD_COMMIT
  "SOURCE_VERSION", // Heroku, in the build
  "RENDER_GIT_COMMIT", // Render
  "RAILWAY_GIT_COMMIT_SHA", // Railway, deploys from GitHub
  "SOURCE_COMMIT", // Coolify
  "KOYEB_GIT_SHA", // Koyeb, deploys from GitHub
  "NF_DEPLOYMENT_SHA", // Northflank
  "CC_COMMIT_ID", // Clever Cloud
  "GIT_REV", // Dokku
  // CI services and builds, when the build passes them on.
  "CODEBUILD_RESOLVED_SOURCE_VERSION", // AWS CodeBuild, and CodePipeline through it
  "GITHUB_SHA", // GitHub Actions
  "CI_COMMIT_SHA", // GitLab CI, Woodpecker, Harness CI
  "BITBUCKET_COMMIT", // Bitbucket Pipelines
  "CIRCLE_SHA1", // CircleCI
  "BUILD_SOURCEVERSION", // Azure Pipelines
  "BUILDKITE_COMMIT", // Buildkite
  "DRONE_COMMIT_SHA", // Drone, Harness CI
  "TRAVIS_COMMIT", // Travis CI
  "SEMAPHORE_GIT_SHA", // Semaphore
  "APPVEYOR_REPO_COMMIT", // AppVeyor
  "GIT_CLONE_COMMIT_HASH", // Bitrise
  "CF_REVISION", // Codefresh
  "GIT_COMMIT", // Jenkins, with the Git plugin
  "COMMIT_REF", // Netlify, in the build
  "AWS_COMMIT_ID", // AWS Amplify, in the build
  "ZEABUR_GIT_COMMIT_SHA", // Zeabur, in the build
  // What a platform names a deploy by when it sets no commit: not commits, and they read as what they are.
  "FLY_IMAGE_REF", // Fly.io: registry.fly.io/<app>:deployment-<id>
  "K_REVISION", // Cloud Run: <service>-<number>-<suffix>
  "GAE_VERSION", // App Engine
] as const;

/**
 * A value that names no version: what a CI service sets before it has resolved the commit (Buildkite before the
 * checkout, Amplify on a rebuild). The variable is passed over, as an empty one is.
 */
const UNRESOLVED = "HEAD";

/** The ECS task metadata endpoints, the current one first. */
const ECS_METADATA_ENV_VARS = ["ECS_CONTAINER_METADATA_URI_V4", "ECS_CONTAINER_METADATA_URI"] as const;

/**
 * The instrumentation's settings: for each, the option `init()` takes and the variable the environment gives it in
 * (DT-133, RF-103). One list, so that every variable has its option and both mean the same: an option is written as its
 * variable's text and read by the same code below. The variables only `downtrace check` sets (`DOWNTRACE_CHECK_…`) are
 * its plumbing, not settings, and have no option.
 */
export const SETTINGS = {
  dsn: { variable: "DOWNTRACE_DSN", kind: "text" },
  token: { variable: "DOWNTRACE_TOKEN", kind: "text" },
  url: { variable: "DOWNTRACE_URL", kind: "text" },
  env: { variable: "DOWNTRACE_ENV", kind: "text" },
  version: { variable: "DOWNTRACE_VERSION", kind: "text" },
  debug: { variable: "DOWNTRACE_DEBUG", kind: "flag" },
  intervalMs: { variable: "DOWNTRACE_INTERVAL_MS", kind: "number" },
  profileMs: { variable: "DOWNTRACE_PROFILE_MS", kind: "number" },
  instrument: { variable: "DOWNTRACE_INSTRUMENT", kind: "list" },
  minimal: { variable: "DOWNTRACE_MINIMAL", kind: "flag" },
  queryText: { variable: "DOWNTRACE_QUERY_TEXT", kind: "onoff" },
  excludeEndpoints: { variable: "DOWNTRACE_EXCLUDE_ENDPOINTS", kind: "list" },
  excludeDependencies: { variable: "DOWNTRACE_EXCLUDE_DEPENDENCIES", kind: "list" },
  inspect: { variable: "DOWNTRACE_INSPECT", kind: "text" },
  shed: { variable: "DOWNTRACE_SHED", kind: "text" },
  pgDepth: { variable: "DOWNTRACE_PG_DEPTH", kind: "text" },
} as const satisfies Record<string, { variable: `DOWNTRACE_${string}`; kind: Kind }>;

/** How an option is written: a string, a boolean (`onoff` is the one whose variable says `off`), a number, a list. */
type Kind = "text" | "flag" | "onoff" | "number" | "list";
interface KindValue {
  text: string;
  flag: boolean;
  onoff: boolean;
  number: number;
  list: string | readonly string[];
}
export type Setting = keyof typeof SETTINGS;

/** What `init()` takes: any of the settings, each optional; one left out is its variable's. */
export type InitOptions = { [K in Setting]?: KindValue[(typeof SETTINGS)[K]["kind"]] | undefined };

const EXPECTED: Record<Kind, string> = {
  text: "a string",
  flag: "true or false",
  onoff: "true or false",
  number: "a number",
  list: "a string or a list of strings",
};

/**
 * An option as its variable's text: undefined when it is left out — absent, `undefined`, `null` or blank, as a blank
 * variable is unset — and null when it is not of its kind.
 */
function textOf(kind: Kind, value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  let text: string | null;
  switch (kind) {
    case "text":
      text = typeof value === "string" ? value : null;
      break;
    case "flag":
      text = typeof value === "boolean" ? String(value) : null;
      break;
    case "onoff":
      text = typeof value === "boolean" ? (value ? "on" : "off") : null;
      break;
    case "number":
      text = typeof value === "number" && Number.isFinite(value) ? String(value) : null;
      break;
    case "list":
      if (typeof value === "string") text = value;
      else text = Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join(",") : null;
      break;
  }
  return text !== null && text.trim() === "" ? undefined : text;
}

/** The settings the code gave, each as its variable's text. */
type Given = Partial<Record<Setting, string>>;

/** The three that connect: a DSN, or a token and a URL. One given in code of the wrong kind leaves nothing to start. */
const CONNECTION: readonly Setting[] = ["dsn", "token", "url"];

/** Whether neither the code nor the environment gives any of the three that connect: then inspecting needs none. */
function nothingToConnect(given: Given, env: NodeJS.ProcessEnv): boolean {
  return CONNECTION.every((setting) => given[setting] === undefined && !env[SETTINGS[setting].variable]?.trim());
}

/**
 * The configuration `init(options)` starts with: the options it was given, and the environment for what they leave out
 * (RF-103). `options` is the application's, unchecked: what is not of its kind is said and left to the variable, except
 * a connection, which is refused rather than taken from somewhere the code did not mean.
 */
export function configFromCode(
  options: unknown,
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): ConfigResult {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    return { ok: false, reason: "init() takes an object of options" };
  }
  const options_ = (options ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];
  for (const name of Object.keys(options_)) {
    if (!Object.hasOwn(SETTINGS, name)) warnings.push(`init() has no option ${name}; it is ignored`);
  }
  const given: Given = {};
  for (const [name, { kind }] of Object.entries(SETTINGS) as Array<[Setting, { kind: Kind }]>) {
    const text = textOf(kind, options_[name]);
    if (text === null) {
      const problem = `init()'s ${name} must be ${EXPECTED[kind]}`;
      if (CONNECTION.includes(name)) return { ok: false, reason: problem };
      warnings.push(`${problem}; it is ignored`);
    } else if (text !== undefined) {
      given[name] = text;
    }
  }
  const result = configFrom({ given, fromCode: true, env, execArgv });
  if (result.ok) result.warnings.unshift(...warnings);
  return result;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): ConfigResult {
  return configFrom({ given: {}, fromCode: false, env, execArgv });
}

/**
 * A token and a URL, from the code or the environment, or why there are none. In each, a DSN gives both; the code's
 * token or URL wins over the environment's, which fills what the code left out.
 */
type Connection = { ok: true; token: string; url: string } | { ok: false; reason: string };
interface Half {
  token?: string | undefined;
  url?: string | undefined;
  /** Where the URL was given, as the start-up's line names it. */
  urlFrom?: string | undefined;
}

function connectionOf(given: Given, env: NodeJS.ProcessEnv, fromCode: boolean): Connection {
  const code = halfOf({ dsn: given.dsn, token: given.token, url: given.url, names: CODE_NAMES });
  if ("reason" in code) return { ok: false, reason: code.reason };
  let environment: Half = {};
  if (code.token === undefined || code.url === undefined) {
    const read = halfOf({
      dsn: env[SETTINGS.dsn.variable],
      token: env[SETTINGS.token.variable],
      url: env[SETTINGS.url.variable],
      names: ENV_NAMES,
    });
    if ("reason" in read) return { ok: false, reason: read.reason };
    environment = read;
  }
  const token = code.token ?? environment.token;
  const url = code.url ?? environment.url;
  const urlFrom = code.url !== undefined ? code.urlFrom : environment.urlFrom;
  const nothing = fromCode ? "init() was given no dsn, and " : "";
  const no = (what: "token" | "url") => (fromCode ? `init() was given no dsn or ${what}, and ` : "");
  if (token === undefined && url === undefined) {
    return { ok: false, reason: `${nothing}DOWNTRACE_DSN is not set, nor DOWNTRACE_TOKEN and DOWNTRACE_URL` };
  }
  if (token === undefined) return { ok: false, reason: `${no("token")}DOWNTRACE_TOKEN is not set` };
  if (url === undefined) return { ok: false, reason: `${no("url")}DOWNTRACE_URL is not set` };
  if (!/^https?:\/\//.test(url)) return { ok: false, reason: `${urlFrom} must start with http:// or https://` };
  if (carriesCredentials(url)) {
    return {
      ok: false,
      reason: `${urlFrom} carries credentials, which fetch refuses in a URL: a URL with the token in it is a DSN, for dsn or DOWNTRACE_DSN`,
    };
  }
  return { ok: true, token, url: url.replace(/\/+$/, "") };
}

const CODE_NAMES = { dsn: "init()'s dsn", url: "init()'s url" };
const ENV_NAMES = { dsn: SETTINGS.dsn.variable, url: SETTINGS.url.variable };

/** One side's token and URL: from its DSN when it has one, or else from its token and URL, each trimmed and blank as unset. */
function halfOf(side: {
  dsn: string | undefined;
  token: string | undefined;
  url: string | undefined;
  names: { dsn: string; url: string };
}): Half | { reason: string } {
  const dsn = side.dsn?.trim();
  if (dsn) {
    const split = splitDsn(dsn, side.names.dsn);
    return "reason" in split ? split : { ...split, urlFrom: side.names.dsn };
  }
  return { token: side.token?.trim() || undefined, url: side.url?.trim() || undefined, urlFrom: side.names.url };
}

const DSN_SHAPE = "it is https://<token>@<host>";

/**
 * A DSN split into the cloud's URL and the ingestion token: `https://dt_…@downtrace.example.com` (RF-104). The token is
 * the URL's user, and the URL keeps the scheme, the host, the port and the path, and never the token: Node's `fetch`
 * refuses a URL with credentials. What is wrong is said by `name`, the option or the variable, and the text itself is
 * never echoed, because it carries the token.
 */
export function splitDsn(dsn: string, name: string): { token: string; url: string } | { reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return { reason: `${name} is not a URL: ${DSN_SHAPE}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { reason: `${name} must start with http:// or https://` };
  }
  if (parsed.username === "") return { reason: `${name} carries no token: ${DSN_SHAPE}` };
  if (parsed.password !== "") return { reason: `${name} carries a password, which a DSN does not: ${DSN_SHAPE}` };
  if (parsed.search !== "" || parsed.hash !== "") {
    return { reason: `${name} carries a query or a fragment, which a DSN does not: ${DSN_SHAPE}` };
  }
  let token: string;
  try {
    token = decodeURIComponent(parsed.username);
  } catch {
    return { reason: `${name}'s token is not valid percent-encoding` };
  }
  return { token, url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") };
}

/** Whether a URL carries a user or a password. One that does not parse carries none that `fetch` would refuse. */
function carriesCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

/**
 * Reads the configuration once, at start-up: each setting from what the code gave, and from its variable when the code
 * gave nothing (RF-103). `fromCode` says whether `init()` is asking, which the reasons name.
 */
function configFrom(input: {
  given: Given;
  fromCode: boolean;
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
}): ConfigResult {
  const { given, env, execArgv } = input;
  const read = (setting: Setting): string | undefined => given[setting] ?? env[SETTINGS[setting].variable];
  const inspect = read("inspect")?.trim();
  const checkRoutes = env.DOWNTRACE_CHECK_ROUTES?.trim();
  const checkProject = env.DOWNTRACE_CHECK_PROJECT?.trim();
  const checkSites = env.DOWNTRACE_CHECK_SITES?.trim();
  const connection = connectionOf(given, env, input.fromCode);
  // Inspecting without a cloud is the path that matters: install, set one variable, run the application, read the
  // file — before handing anything to anyone. Half a cloud is still a mistake worth naming, inspection or not.
  const inspectOnly = inspect !== undefined && inspect !== "" && nothingToConnect(given, env);
  if (!connection.ok && !inspectOnly) return connection;

  const interval = Number(read("intervalMs"));
  const intervalMs = Number.isInteger(interval) && interval >= MIN_INTERVAL_MS ? interval : DEFAULT_INTERVAL_MS;
  const profile = Number(read("profileMs"));
  const warnings: string[] = [];
  // Shortening it multiplies the profile rows in proportion, and those count against the project's daily
  // budget (invariant 8). The floor is not a number chosen here: it is the interval, because below it the
  // setting changes nothing. The ceiling is derived the same way (profileCeilingMs); above it the number
  // would no longer buy a profile in the report's window, so it is clamped and said at start-up rather than
  // taken silently, which is not a no-op the way the floor is.
  let profileMs = PROFILE_WINDOW_MS;
  if (Number.isInteger(profile) && profile > 0) {
    const ceiling = profileCeilingMs(intervalMs);
    profileMs = Math.min(Math.max(profile, intervalMs), ceiling);
    if (profile > ceiling) {
      warnings.push(
        `DOWNTRACE_PROFILE_MS=${profile} is above the ceiling of ${ceiling} ms, above which the report's recent window can hold no profile that has arrived; using ${ceiling}`,
      );
    }
  }
  // The version the code names wins over every variable of the chain, and says so where the start-up names the source.
  const named =
    given.version !== undefined
      ? { version: clamp(given.version, 128), from: "init({ version })" }
      : versionFromEnv(env);
  const debug = read("debug");
  const minimal = read("minimal");
  return {
    ok: true,
    config: {
      token: connection.ok ? connection.token : "",
      url: connection.ok ? connection.url : "",
      environment: clamp(read("env") ?? env.NODE_ENV ?? "production", 64),
      version: named?.version ?? "unknown",
      versionFrom: named?.from,
      ecsMetadataUri: ecsMetadataUri(env),
      debug: debug === "1" || debug === "true",
      intervalMs,
      profileMs,
      instrument: parseInstruments(read("instrument")),
      queryText: read("queryText")?.trim().toLowerCase() !== "off",
      minimal: minimal === "1" || minimal?.trim().toLowerCase() === "true",
      shed: parseShed(read("shed")),
      pgDepth: parsePgDepth(read("pgDepth")),
      preserveSymlinksMain: preservesSymlinksMain(execArgv, env.NODE_OPTIONS),
      excludeEndpoints: patternsOf(read("excludeEndpoints")),
      excludeDependencies: patternsOf(read("excludeDependencies")),
      inspect: inspect === "" ? undefined : inspect,
      checkRoutes: checkRoutes === "" ? undefined : checkRoutes,
      checkProject: checkProject !== undefined && isAbsolute(checkProject) ? checkProject : undefined,
      checkSites: checkSites === "" ? undefined : checkSites,
    },
    warnings,
  };
}

/** The version the variables name, or `unknown`. The rest of the chain runs at start-up (`deployed.ts`). */
export function detectVersion(env: NodeJS.ProcessEnv): string {
  return versionFromEnv(env)?.version ?? "unknown";
}

/** The first variable of `VERSION_ENV_VARS` that names a version, and the version, clamped to what the protocol takes. */
export function versionFromEnv(env: NodeJS.ProcessEnv): { version: string; from: string } | undefined {
  for (const name of VERSION_ENV_VARS) {
    const v = env[name]?.trim();
    if (v && v !== UNRESOLVED) return { version: clamp(v, 128), from: name };
  }
  return undefined;
}

/** The ECS task metadata endpoint, when this process runs on ECS; anything that is not an http(s) URL is none. */
function ecsMetadataUri(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ECS_METADATA_ENV_VARS) {
    const uri = env[name]?.trim();
    if (uri && /^https?:\/\//.test(uri)) return uri;
  }
  return undefined;
}

function clamp(value: string, max: number): string {
  const v = value.trim();
  return v.length > max ? v.slice(0, max) : v || "unknown";
}

/**
 * Reads which observers to run. `all` (the default) or an unset variable turns on everything; `none` turns off
 * everything; anything else is a comma-separated list of names, and unknown names are ignored rather than fatal:
 * an operator's typo should not take the agent down with it.
 */
/**
 * Reads the floor under the meter's shedding level (gh-570): `nothing` (the default), `fine` or `profile`.
 * Anything else is `nothing`, the way an unknown observer name is ignored: a typo must not take the agent down,
 * and this is the benchmark's switch, not an operator's.
 */
export function parseShed(value: string | undefined): SheddableLevel {
  switch ((value ?? "").trim().toLowerCase()) {
    case "fine":
      return Sheddable.Fine;
    case "profile":
      return Sheddable.Profile;
    default:
      return Sheddable.Nothing;
  }
}

/**
 * Reads how much of the Postgres observer runs (gh-592): `full` (the default), `context` or `wrapper`.
 * Anything else is `full`, the way an unknown observer name is ignored: a typo must not take the agent down,
 * and this is the benchmark's switch, not an operator's.
 */
export function parsePgDepth(value: string | undefined): PgDepth {
  switch ((value ?? "").trim().toLowerCase()) {
    case "wrapper":
      return "wrapper";
    case "context":
      return "context";
    default:
      return "full";
  }
}

export function parseInstruments(value: string | undefined): ReadonlySet<Instrument> {
  const raw = (value ?? "all").trim().toLowerCase();
  if (raw === "" || raw === "all" || raw === "auto") return new Set(INSTRUMENTS);
  if (raw === "none") return new Set();
  const wanted = new Set(raw.split(",").map((name) => name.trim()));
  return new Set(INSTRUMENTS.filter((name) => wanted.has(name)));
}
