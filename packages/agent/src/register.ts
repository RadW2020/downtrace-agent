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

const result = configFromEnv();
if (result.ok) {
  createAgent(result.config, { log: createLogger(result.config.debug), handleSignals: true }).start();
} else {
  createLogger(false).warn(`agent disabled: ${result.reason}`);
}
