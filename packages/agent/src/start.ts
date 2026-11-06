/**
 * What `register` runs once it knows the Node is one the package runs on.
 *
 * Reads DOWNTRACE_DSN, or DOWNTRACE_TOKEN and DOWNTRACE_URL (and friends), from the environment and starts the
 * instrumentation. Without them it says so once and does nothing else: an installed but unconfigured
 * instrumentation must never affect the application.
 */
import { activate } from "./activate.ts";
import { configFromEnv } from "./config.ts";

activate(configFromEnv());
