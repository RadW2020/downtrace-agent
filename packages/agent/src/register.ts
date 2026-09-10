/**
 * Entry point users load with `node --import @downtrace/agent/register`.
 *
 * Reads DOWNTRACE_TOKEN / DOWNTRACE_URL (and friends) from the environment and
 * starts the agent. Without them it says so once and does nothing else: an
 * installed but unconfigured agent must never affect the application.
 */
import { createAgent } from "./agent.ts";
import { configFromEnv } from "./config.ts";
import { createLogger } from "./log.ts";
import { remember } from "./registered.ts";

const result = configFromEnv();
if (result.ok) {
  const agent = createAgent(result.config, { log: createLogger(result.config.debug), handleSignals: true });
  agent.start();
  // So an application that calls `process.exit()` can wait for it: that call fires nothing and waits for
  // nothing, and without this the last flush is simply cut (gh-383).
  remember(agent);
} else {
  createLogger(false).warn(`instrumentation disabled: ${result.reason}`);
}
