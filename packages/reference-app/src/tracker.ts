import type express from "express";
import type { AppConfig } from "./config.ts";

/**
 * The error tracker this application can be loaded beside, in the same process (ESC-16).
 *
 * `product.md:364` says the replacement goes «first beside the tracker, then instead of it», because two
 * instrumentations in one process is the state every migration goes through. This is the reference app's half
 * of that: a small surface, so that nothing else here knows which tracker it is, and `@sentry/node` stays a
 * development dependency of this package alone — never of `@downtrace/agent`.
 *
 * The two things a tracker needs that no hook can give it are exactly the two Downtrace needs (ERR-02), which
 * is why they are the two methods here: the error the framework turned into a 5xx, and the one the application
 * handled itself. Beside the tracker both are called; the migration is deleting one of the two calls.
 */
export interface Tracker {
  /**
   * The tracker's own Express error middleware, registered where the application decides —`config` says on
   * which side of Downtrace's it goes— and not where the tracker would have put it.
   */
  setupErrorHandler(app: express.Express): void;
  /**
   * The tracker's explicit report, called beside `captureException` of `@downtrace/agent`. The context is
   * structural, the same one both are given: the migration is replacing the import, not rewriting the call.
   */
  captureException(error: unknown, context: Record<string, string | number | boolean>): void;
}

/**
 * The tracker this process was started with, or nothing.
 *
 * Nothing is the normal case and the benchmark's: without `SENTRY_DSN` this never imports `@sentry/node`, so a
 * run that is not comparing the two costs nothing for the possibility.
 *
 * A DSN with no tracker loaded is a mistake worth stopping for, not worth guessing about: it means somebody
 * asked for the comparison and will otherwise read a run with one instrumentation as a run with two.
 */
export async function loadTracker(config: AppConfig): Promise<Tracker | undefined> {
  if (config.trackerDsn === "") return undefined;
  const Sentry = await import("@sentry/node");
  if (Sentry.getClient() === undefined) {
    throw new Error(
      "SENTRY_DSN is set but @sentry/node was never initialised: it has to be loaded before the application, " +
        "with `node --import ./src/sentry.ts src/main.ts` (see the README)",
    );
  }
  return {
    setupErrorHandler(app) {
      Sentry.setupExpressErrorHandler(app);
    },
    captureException(error, context) {
      Sentry.captureException(error, { extra: context });
    },
  };
}
