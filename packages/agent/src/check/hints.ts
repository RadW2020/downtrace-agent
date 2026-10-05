/**
 * What to say when a run left no profile (LOC-01, COB-01).
 *
 * The instrumentation writes what it holds when its process ends in an orderly way, and once a window has closed;
 * a runner that ends the process without letting that happen cuts the last one off, and one that runs the tests
 * in threads that are terminated never lets them write. The file does not say it lost anything — a process that
 * wrote nothing looks like a process that served nothing — so the only thing `check` can do is name the likely
 * cause from the command it ran and say what to use instead. It never lets the absence read as «unchanged».
 */

export interface LosingRunner {
  /** The runner and the setting, as a person names them. */
  runner: string;
  /** What in the command line gives it away. */
  matches: RegExp;
  /** What to use instead. */
  use: string;
}

/** Every runner setting known to end a run without its profile. The README table is this list. */
export const LOSING_RUNNERS: readonly LosingRunner[] = [
  {
    runner: "node --test --test-force-exit",
    matches: /(^|\s)--test-force-exit(\s|=|$)/,
    use: "drop --test-force-exit",
  },
  { runner: "Jest --forceExit", matches: /(^|\s)--forceExit(\s|=|$)/, use: "drop --forceExit" },
  { runner: "Mocha --exit", matches: /(^|\s)--exit(\s|=|$)/, use: "drop --exit" },
  { runner: "Mocha --parallel", matches: /(^|\s)--parallel(\s|=|$)/, use: "drop --parallel" },
  {
    runner: "Vitest with the threads or vmThreads pool",
    matches: /(^|\s)--pool(\s+|=)['"]?(threads|vmThreads)\b/,
    use: "use --pool=forks, which is Vitest's default",
  },
];

const GENERIC =
  "This happens when no test reaches a route of the application in a process that loads the instrumentation, or " +
  "when the runner ends the process without letting it write: node --test --test-force-exit, Jest --forceExit, " +
  "Mocha --exit or --parallel, Vitest with the threads pool. Run the tests without those, with --pool=forks " +
  "for Vitest.";

/** The sentence that follows «the run left no profile»: this happens with X, use Y. */
export function adviceForNoProfile(command: string): string {
  const found = LOSING_RUNNERS.filter((runner) => runner.matches.test(command));
  if (found.length === 0) return GENERIC;
  const happens = found.map((runner) => runner.runner).join(" and ");
  const use = found.map((runner) => runner.use).join(", and ");
  return `This happens with ${happens}, which end the process without letting the instrumentation write: ${use}.`;
}
