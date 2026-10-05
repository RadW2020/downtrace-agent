/**
 * What to say when a run left no profile (LOC-01, COB-01).
 *
 * The instrumentation writes what it holds when its process ends in an orderly way, once a window has closed, and,
 * when it only writes a file as it does in a run of `check`, when the process exits, so a runner that ends its
 * processes with `process.exit()` keeps the profile (DT-79, ADR 0230). What no process can write is what a runner
 * stops without letting it run: the threads of a pool that terminates them. The file does not say it lost
 * anything — a process that wrote nothing looks like a process that served nothing — so the only thing `check`
 * can do is name the likely cause from the command it ran and say what to use instead. It never lets the absence
 * read as «unchanged».
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
    runner: "Vitest with the threads or vmThreads pool",
    matches: /(^|\s)--pool(\s+|=)['"]?(threads|vmThreads)\b/,
    use: "use --pool=forks, which is Vitest's default",
  },
];

const GENERIC =
  "This happens when no test reaches a route of the application in a process that loads the instrumentation, or " +
  "when the runner stops the threads that run the tests without letting them write: Vitest with the threads or " +
  "vmThreads pool. Run the tests with --pool=forks for Vitest.";

/** The sentence that follows «the run left no profile»: this happens with X, use Y. */
export function adviceForNoProfile(command: string): string {
  const found = LOSING_RUNNERS.filter((runner) => runner.matches.test(command));
  if (found.length === 0) return GENERIC;
  const happens = found.map((runner) => runner.runner).join(" and ");
  const use = found.map((runner) => runner.use).join(", and ");
  return `This happens with ${happens}, which end the processes or threads that run the tests without letting the instrumentation write: ${use}.`;
}
