export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(message, 404);
  }
}

/** Raised by the `new_error` regression: a "new" failure type appearing in production. */
export class InventoryMismatchError extends HttpError {
  constructor(productId: number) {
    super(`inventory mismatch for product ${productId}`, 500);
  }
}

/** The external provider failed after all attempts. */
export class ProviderError extends HttpError {
  constructor(message: string, cause?: unknown) {
    super(message, 502, cause === undefined ? undefined : { cause });
  }
}

/** The application is still warming up (STARTUP_FAILURE_MS): a simulated cold database. */
export class ColdStartError extends HttpError {
  constructor() {
    super("database not ready yet", 503);
  }
}

/** Could not obtain a database connection from the pool in time. */
export class PoolTimeoutError extends HttpError {
  constructor(cause?: unknown) {
    super("timed out waiting for a database connection", 503, cause === undefined ? undefined : { cause });
  }
}

/**
 * Postgres refused, or could not run, the CHECKPOINT that ends a database reset (gh-584).
 *
 * The reset restarts the timed-checkpoint clock so that no round of the benchmark meets one. A reset that left the
 * clock running would put us back where gh-584 started —the checkpoint inside round 8 of every campaign and nothing
 * comparable— so it fails, and says what the database needs (ADR 0021: a reset that fails aborts the measurement).
 */
export class CheckpointError extends HttpError {
  constructor(message: string, cause: unknown) {
    super(message, 500, { cause });
  }
}

/** SQLSTATE 42501, insufficient_privilege: CHECKPOINT needs a superuser or, from Postgres 15, the pg_checkpoint role. */
const INSUFFICIENT_PRIVILEGE = "42501";

/** Translates whatever `pg` threw for CHECKPOINT into an error that says what failed and what it takes. */
export function checkpointError(cause: unknown): CheckpointError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  if (code === INSUFFICIENT_PRIVILEGE) {
    return new CheckpointError(
      "CHECKPOINT was refused: the database reset needs a superuser or the pg_checkpoint role, so that every round " +
        `of the benchmark starts with the timed-checkpoint clock at zero (gh-584): ${detail}`,
      cause,
    );
  }
  return new CheckpointError(`CHECKPOINT failed after the database reset (gh-584): ${detail}`, cause);
}
