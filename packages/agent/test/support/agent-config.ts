import { type AgentConfig, configFromEnv } from "../../src/config.ts";

/**
 * The `AgentConfig` `configFromEnv` would build for a minimal, valid environment — a token and a url, and
 * nothing else — with whatever a test needs layered on top.
 *
 * Building it this way means the base a test runs against is always what production would compute today,
 * not a snapshot of it: a changed default propagates into every call site on its own, and a test that wants
 * something else says so explicitly instead of silently keeping the old value (gh-567).
 */
export function testConfig(url: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  const result = configFromEnv({ DOWNTRACE_TOKEN: "test-token", DOWNTRACE_URL: url });
  if (!result.ok) throw new Error(`configFromEnv rejected a minimal test environment: ${result.reason}`);
  return { ...result.config, ...overrides };
}
