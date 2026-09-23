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
  /**
   * Where the error tracker this app can be loaded beside sends what it captures (SENTRY_DSN env); empty when
   * this process runs without one (ESC-16).
   *
   * It is read here, with everything else, because this module is the one place that reads the environment.
   * `src/sentry.ts` —the file the tracker is loaded from, before the application exists— asks this function
   * rather than `process.env`.
   */
  trackerDsn: string;
  /**
   * Where the tracker's Express error middleware sits relative to Downtrace's (TRACKER_ERROR_HANDLER env):
   * `after` it, the default, or `before` it.
   *
   * Both of them record and call `next(err)`, so both see the error whichever way round they are and the
   * response is the one this app would have given with neither. That is a claim, and a claim wants a test
   * that runs it both ways round, so it is a setting (ESC-16).
   */
  trackerErrorHandler: TrackerErrorHandlerPosition;
}

/** The two places the tracker's error middleware can sit, relative to Downtrace's. */
export const TRACKER_ERROR_HANDLER_POSITIONS = ["before", "after"] as const;
export type TrackerErrorHandlerPosition = (typeof TRACKER_ERROR_HANDLER_POSITIONS)[number];

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
    trackerDsn: env.SENTRY_DSN?.trim() ?? "",
    trackerErrorHandler: trackerErrorHandler(env.TRACKER_ERROR_HANDLER),
  };
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

/** An unknown position is a typo, and a typo that silently picked a side would decide what a test is measuring. */
function trackerErrorHandler(value: string | undefined): TrackerErrorHandlerPosition {
  const wanted = value?.trim();
  if (wanted === undefined || wanted === "") return "after";
  const known = TRACKER_ERROR_HANDLER_POSITIONS.find((position) => position === wanted);
  if (known === undefined) {
    throw new Error(
      `TRACKER_ERROR_HANDLER must be one of ${TRACKER_ERROR_HANDLER_POSITIONS.join(", ")}; got ${JSON.stringify(wanted)}`,
    );
  }
  return known;
}
