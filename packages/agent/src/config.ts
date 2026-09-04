export interface AgentConfig {
  token: string;
  /** Ingest base URL, without trailing slash. */
  url: string;
  environment: string;
  version: string;
  debug: boolean;
  /** Aggregation interval; 10 s in production. */
  intervalMs: number;
}

export type ConfigResult = { ok: true; config: AgentConfig } | { ok: false; reason: string };

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
  if (token === "" && rawUrl === "") return { ok: false, reason: "DOWNTRACE_TOKEN and DOWNTRACE_URL are not set" };
  if (token === "") return { ok: false, reason: "DOWNTRACE_TOKEN is not set" };
  if (rawUrl === "") return { ok: false, reason: "DOWNTRACE_URL is not set" };
  if (!/^https?:\/\//.test(rawUrl)) return { ok: false, reason: "DOWNTRACE_URL must start with http:// or https://" };

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
