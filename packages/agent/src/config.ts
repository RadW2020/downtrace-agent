import { preservesSymlinksMain } from "./entry.ts";
import { patternsOf } from "./exclude.ts";
import { Sheddable, type SheddableLevel } from "./overhead.ts";
import { PROFILE_WINDOW_MS } from "./profile.ts";

export interface AgentConfig {
  token: string;
  /** Ingest base URL, without trailing slash. */
  url: string;
  environment: string;
  version: string;
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
export const INSTRUMENTS = ["pg", "mysql", "http", "redis", "runtime"] as const;
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

/** Env vars commonly set by deploy platforms, in order of preference, used when DOWNTRACE_VERSION is absent. */
export const VERSION_ENV_VARS = [
  "DOWNTRACE_VERSION",
  "APP_VERSION",
  "GIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "HEROKU_SLUG_COMMIT",
  "SOURCE_VERSION",
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
] as const;

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): ConfigResult {
  const token = env.DOWNTRACE_TOKEN?.trim() ?? "";
  const rawUrl = env.DOWNTRACE_URL?.trim() ?? "";
  const inspect = env.DOWNTRACE_INSPECT?.trim();
  // Inspecting without a cloud is the path that matters: install, set one variable, run the application, read the
  // file — before handing anything to anyone. Half a cloud is still a mistake worth naming, inspection or not.
  const inspectOnly = inspect !== undefined && inspect !== "" && token === "" && rawUrl === "";
  if (!inspectOnly) {
    if (token === "" && rawUrl === "") return { ok: false, reason: "DOWNTRACE_TOKEN and DOWNTRACE_URL are not set" };
    if (token === "") return { ok: false, reason: "DOWNTRACE_TOKEN is not set" };
    if (rawUrl === "") return { ok: false, reason: "DOWNTRACE_URL is not set" };
    if (!/^https?:\/\//.test(rawUrl)) {
      return { ok: false, reason: "DOWNTRACE_URL must start with http:// or https://" };
    }
  }

  const interval = Number(env.DOWNTRACE_INTERVAL_MS);
  const intervalMs = Number.isInteger(interval) && interval >= MIN_INTERVAL_MS ? interval : DEFAULT_INTERVAL_MS;
  const profile = Number(env.DOWNTRACE_PROFILE_MS);
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
  return {
    ok: true,
    config: {
      token,
      url: rawUrl.replace(/\/+$/, ""),
      environment: clamp(env.DOWNTRACE_ENV ?? env.NODE_ENV ?? "production", 64),
      version: detectVersion(env),
      debug: env.DOWNTRACE_DEBUG === "1" || env.DOWNTRACE_DEBUG === "true",
      intervalMs,
      profileMs,
      instrument: parseInstruments(env.DOWNTRACE_INSTRUMENT),
      queryText: env.DOWNTRACE_QUERY_TEXT?.trim().toLowerCase() !== "off",
      minimal: env.DOWNTRACE_MINIMAL === "1" || env.DOWNTRACE_MINIMAL?.trim().toLowerCase() === "true",
      shed: parseShed(env.DOWNTRACE_SHED),
      pgDepth: parsePgDepth(env.DOWNTRACE_PG_DEPTH),
      preserveSymlinksMain: preservesSymlinksMain(execArgv, env.NODE_OPTIONS),
      excludeEndpoints: patternsOf(env.DOWNTRACE_EXCLUDE_ENDPOINTS),
      excludeDependencies: patternsOf(env.DOWNTRACE_EXCLUDE_DEPENDENCIES),
      inspect: inspect === "" ? undefined : inspect,
    },
    warnings,
  };
}

export function detectVersion(env: NodeJS.ProcessEnv): string {
  for (const name of VERSION_ENV_VARS) {
    const v = env[name]?.trim();
    if (v) return clamp(v, 128);
  }
  return "unknown";
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
