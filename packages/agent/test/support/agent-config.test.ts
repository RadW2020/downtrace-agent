import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULT_INTERVAL_MS } from "../../src/config.ts";
import { PROFILE_WINDOW_MS } from "../../src/profile.ts";
import { testConfig } from "./agent-config.ts";

/**
 * `testConfig` is the base every other test in this package now builds its `AgentConfig` from. Its only
 * job is to track `configFromEnv`'s real output, so this only checks that tracking, not `configFromEnv`
 * itself — that belongs to `config.test.ts`.
 */
describe("testConfig", () => {
  it("matches configFromEnv's own defaults for the same minimal environment", () => {
    const result = configFromEnv({ DOWNTRACE_TOKEN: "test-token", DOWNTRACE_URL: "http://sink.invalid" });
    if (!result.ok) throw new Error(result.reason);
    expect(testConfig("http://sink.invalid")).toEqual(result.config);
  });

  it("threads the url through, normalised the same way configFromEnv normalises it", () => {
    expect(testConfig("http://sink.invalid/").url).toBe("http://sink.invalid");
  });

  it("lets overrides win over whatever configFromEnv would have produced", () => {
    const config = testConfig("http://sink.invalid", { intervalMs: 1_234, environment: "test" });
    expect(config.intervalMs).toBe(1_234);
    expect(config.environment).toBe("test");
    // Everything not overridden is still production's default, not something the override call made up.
    expect(config.profileMs).toBe(PROFILE_WINDOW_MS);
  });

  it("still defaults to production's interval when nothing overrides it", () => {
    expect(testConfig("http://sink.invalid").intervalMs).toBe(DEFAULT_INTERVAL_MS);
  });
});
