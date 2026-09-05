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
