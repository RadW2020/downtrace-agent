/**
 * Entry point users load with `node --import @downtrace/agent/register`, or import from code of their own.
 *
 * It checks the Node it runs on before the rest of the package is loaded: only the check and the logger are, and
 * neither imports anything. Below the floor it says so once and does nothing else, as it does without a token
 * (DT-131). What starts the instrumentation is imported only after the check, and dynamically: a static import is
 * evaluated before this module's body, and a syntax or an API the old runtime lacks would fail there, before any
 * check could run. The await is what makes `--import` wait for the start, so the instrumentation is in place
 * before the application loads, as before.
 */
import { createLogger } from "./log.ts";
import { unsupportedNode } from "./node-floor.ts";

const unsupported = unsupportedNode(process.versions.node);
if (unsupported === undefined) await import("./start.ts");
else createLogger(false).warn(`instrumentation disabled: ${unsupported}`);
