import { patternsOf } from "./exclude.ts";

export interface AgentConfig {
  token: string;
  /** Ingest base URL, without trailing slash. */
  url: string;
  environment: string;
  version: string;
  debug: boolean;
  /** Aggregation interval; 10 s in production. */
  intervalMs: number;
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
}

export type ConfigResult = { ok: true; config: AgentConfig } | { ok: false; reason: string };

/** Everything the agent can observe, each switchable on its own so its cost can be measured on its own. */
export const INSTRUMENTS = ["pg", "http", "redis", "runtime"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;

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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigResult {
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
  return {
    ok: true,
    config: {
      token,
      url: rawUrl.replace(/\/+$/, ""),
      environment: clamp(env.DOWNTRACE_ENV ?? env.NODE_ENV ?? "production", 64),
      version: detectVersion(env),
      debug: env.DOWNTRACE_DEBUG === "1" || env.DOWNTRACE_DEBUG === "true",
      intervalMs: Number.isInteger(interval) && interval >= MIN_INTERVAL_MS ? interval : DEFAULT_INTERVAL_MS,
      instrument: parseInstruments(env.DOWNTRACE_INSTRUMENT),
      queryText: env.DOWNTRACE_QUERY_TEXT?.trim().toLowerCase() !== "off",
      minimal: env.DOWNTRACE_MINIMAL === "1" || env.DOWNTRACE_MINIMAL?.trim().toLowerCase() === "true",
      excludeEndpoints: patternsOf(env.DOWNTRACE_EXCLUDE_ENDPOINTS),
      excludeDependencies: patternsOf(env.DOWNTRACE_EXCLUDE_DEPENDENCIES),
      inspect: inspect === "" ? undefined : inspect,
    },
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
export function parseInstruments(value: string | undefined): ReadonlySet<Instrument> {
  const raw = (value ?? "all").trim().toLowerCase();
  if (raw === "" || raw === "all" || raw === "auto") return new Set(INSTRUMENTS);
  if (raw === "none") return new Set();
  const wanted = new Set(raw.split(",").map((name) => name.trim()));
  return new Set(INSTRUMENTS.filter((name) => wanted.has(name)));
}
