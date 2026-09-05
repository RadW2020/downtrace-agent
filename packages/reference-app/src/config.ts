export interface AppConfig {
  port: number;
  providerPort: number;
  databaseUrl: string;
  redisUrl: string;
  appVersion: string;
  adminEnabled: boolean;
  /** Comma-separated regressions enabled at startup (REGRESSIONS env). */
  regressions: string;
  pgPoolMax: number;
  pgConnectionTimeoutMs: number;
  /**
   * Answer 503 to product traffic for this many ms after the first request
   * (STARTUP_FAILURE_MS env): a stand-in for a cold database. 0 disables.
   */
  startupFailureMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: integer(env.PORT, 4000),
    providerPort: integer(env.PROVIDER_PORT, 4001),
    databaseUrl: env.DATABASE_URL ?? "postgres://downtrace:downtrace@localhost:5432/downtrace",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    appVersion: env.APP_VERSION ?? "dev",
    adminEnabled: (env.ADMIN_ENABLED ?? "1") !== "0",
    regressions: env.REGRESSIONS ?? "",
    pgPoolMax: integer(env.PG_POOL_MAX, 10),
    pgConnectionTimeoutMs: integer(env.PG_CONNECTION_TIMEOUT_MS, 5000),
    startupFailureMs: integer(env.STARTUP_FAILURE_MS, 0),
  };
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}
