import type { Agent } from "./agent.ts";

/**
 * The agent that `--import @downtrace/agent/register`, or `init()`, started, so an application that is about to leave
 * can wait for it.
 *
 * This is process state, and this package says dependencies are passed explicitly and nothing is reached
 * for. The exception is argued in the ADR and the short version is: `--import` runs **before** the
 * application exists, so there is no call chain to pass the agent along. The application cannot receive
 * what was created before it. Either it can reach the instrumentation by name, or an application that calls
 * `process.exit()` silently loses its last interval, its profile window and any capture evidence — which is
 * what was happening (gh-383).
 *
 * Two values, both touched by this module only: the agent, and the drain under way beside it. Nothing
 * else in the package touches them: the agent itself takes everything it needs as arguments, and this
 * module knows nothing about what an agent does.
 *
 * They live under a key of the process's, and not in this module, because a process can hold two copies of the
 * package (DT-133): the one `downtrace check` loads with `--import` and the application's own, or a CommonJS and an
 * ES module copy. Each copy is a module of its own, and with the state in it, `init()` in one did not see the
 * instrumentation the other had started, and started a second. A symbol is not a global by name.
 */
const SLOT = Symbol.for("@downtrace/agent.registered");

interface Registered {
  running: Agent | undefined;
  /**
   * The drain `shutdown()` is under way, beside the agent it started. A second call that finds it returns it:
   * the second caller is the one about to `process.exit()`, and a promise that settles in the instant cuts
   * the first drain's last batch with the process (gh-690). Forgotten when it settles.
   */
  draining: Promise<void> | undefined;
}

function state(): Registered {
  const process_ = globalThis as { [SLOT]?: Registered };
  process_[SLOT] ??= { running: undefined, draining: undefined };
  return process_[SLOT];
}

/** Remembers the agent the entry point started. Called once, by `register` or `init()`. */
export function remember(agent: Agent): void {
  state().running = agent;
}

/**
 * The running instrumentation, or undefined when there is none.
 *
 * The second reader of this variable, and its argument is `shutdown`'s: `captureException` is called from the
 * application's own code, which was loaded after `--import` had already built the agent, so there is no call
 * chain along which it could have been handed one. Undefined is an ordinary answer — an unconfigured process,
 * one that has already shut down, a test that started no agent — and every caller has to do nothing with it
 * rather than fail.
 */
export function registered(): Agent | undefined {
  return state().running;
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
 * twice: a second call that finds the first still draining waits for the same drain, because its caller is
 * the one about to `process.exit()` (gh-690). Never throws: an application on its way out has nothing to do
 * with an error from its telemetry.
 */
export async function shutdown(): Promise<void> {
  const registered_ = state();
  if (registered_.draining !== undefined) return registered_.draining;
  const agent = registered_.running;
  registered_.running = undefined;
  if (!agent) return;
  registered_.draining = (async () => {
    try {
      await agent.stop();
    } catch {
      // Deliberately swallowed, and the only place in this package where that is right: the application is
      // leaving, this is the last thing it does, and there is nobody left to tell.
    } finally {
      registered_.draining = undefined;
    }
  })();
  await registered_.draining;
}
