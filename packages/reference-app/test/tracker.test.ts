import { describe, expect, it } from "vitest";
import { type AppConfig, configFromEnv, TRACKER_ERROR_HANDLER_POSITIONS } from "../src/config.ts";
import { loadTracker } from "../src/tracker.ts";

/**
 * The two ways running beside the error tracker can be misconfigured, and why both stop the process.
 *
 * Neither is exercised by `coexistence.integration.test.ts`, which always configures itself correctly — and
 * the failure they guard against is the kind that reads as a result rather than as a fault. If
 * `TRACKER_ERROR_HANDLER` fell back to `after` on a typo, the coexistence test would go on measuring `after`
 * while believing it was measuring `before`, and both runs would agree because they were the same run. If a
 * DSN with no tracker loaded were ignored, a run with one instrumentation would be read as a run with two.
 *
 * So both throw, and these are the tests that say so. A unit test is enough: what is being checked is a
 * decision about an input, and it holds on any machine.
 */

/** The environment the reference app reads, with only what a case is about set. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { DATABASE_URL: "postgres://x/y", REDIS_URL: "redis://x", ...overrides };
}

describe("TRACKER_ERROR_HANDLER", () => {
  it("defaults to `after` when it is unset or empty", () => {
    expect(configFromEnv(env()).trackerErrorHandler).toBe("after");
    expect(configFromEnv(env({ TRACKER_ERROR_HANDLER: "" })).trackerErrorHandler).toBe("after");
    expect(configFromEnv(env({ TRACKER_ERROR_HANDLER: "  " })).trackerErrorHandler).toBe("after");
  });

  // Enumerated from the source: a third position added there and forgotten here would otherwise go unread.
  it.each(TRACKER_ERROR_HANDLER_POSITIONS)("takes %s, with surrounding space", (position) => {
    expect(configFromEnv(env({ TRACKER_ERROR_HANDLER: position })).trackerErrorHandler).toBe(position);
    expect(configFromEnv(env({ TRACKER_ERROR_HANDLER: ` ${position} ` })).trackerErrorHandler).toBe(position);
  });

  it("refuses anything else, naming what it got and what it takes", () => {
    expect(() => configFromEnv(env({ TRACKER_ERROR_HANDLER: "AFTER" }))).toThrow(/must be one of before, after/);
    expect(() => configFromEnv(env({ TRACKER_ERROR_HANDLER: "first" }))).toThrow(/got "first"/);
    // The one that matters: a near miss of a real position. Falling back to the default here is what would
    // make one of the two orders of `coexistence.integration.test.ts` silently be the other.
    expect(() => configFromEnv(env({ TRACKER_ERROR_HANDLER: "befor" }))).toThrow(/got "befor"/);
  });
});

describe("loadTracker", () => {
  const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({ ...configFromEnv(env()), ...overrides });

  it("loads nothing at all without a DSN, which is the normal case", async () => {
    await expect(loadTracker(config({ trackerDsn: "" }))).resolves.toBeUndefined();
  });

  it("refuses a DSN whose tracker was never loaded, and says how to load it", async () => {
    // `@sentry/node` is importable here and has no client, because nothing called `Sentry.init`: exactly the
    // state of an application started without `--import ./src/sentry.ts`.
    await expect(loadTracker(config({ trackerDsn: "http://publickey@127.0.0.1:1/1" }))).rejects.toThrow(
      /SENTRY_DSN is set but @sentry\/node was never initialised/,
    );
  });
});
