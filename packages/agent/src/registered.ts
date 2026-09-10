import type { Agent } from "./agent.ts";

/**
 * The agent that `--import @downtrace/agent/register` started, so an application that is about to leave can
 * wait for it.
 *
 * This is module state, and this package says dependencies are passed explicitly and nothing is reached
 * for. The exception is argued in the ADR and the short version is: `--import` runs **before** the
 * application exists, so there is no call chain to pass the agent along. The application cannot receive
 * what was created before it. Either it can reach the instrumentation by name, or an application that calls
 * `process.exit()` silently loses its last interval, its profile window and any capture evidence — which is
 * what was happening (gh-383).
 *
 * One variable, written once, read by one function. Nothing else in the package touches it: the agent
 * itself takes everything it needs as arguments, and this module knows nothing about what an agent does.
 */
let running: Agent | undefined;

/** Remembers the agent the entry point started. Called once, by `register.ts`. */
export function remember(agent: Agent): void {
  running = agent;
}

/**
 * Hands over everything the instrumentation is holding, for an application that is about to exit.
 *
 * `process.exit()` does not wait for a promise in flight and does not fire `beforeExit`, so an application
 * that calls it cuts the last flush. Awaiting this first is the two lines that stop that happening:
 *
 * ```js
 * import { shutdown } from "@downtrace/agent";
 * await shutdown();
 * process.exit(0);
 * ```
 *
 * Safe to call when the instrumentation is off — an unconfigured agent was never started — and safe to call
 * twice: the second time there is nothing left to send. Never throws: an application on its way out has
 * nothing to do with an error from its telemetry.
 */
export async function shutdown(): Promise<void> {
  const agent = running;
  running = undefined;
  if (!agent) return;
  try {
    await agent.stop();
  } catch {
    // Deliberately swallowed, and the only place in this package where that is right: the application is
    // leaving, this is the last thing it does, and there is nobody left to tell.
  }
}
