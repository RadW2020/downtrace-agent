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
 *
 * Nor can anything write in a process the instrumentation was never loaded into. `check` loads it by adding to the
 * `NODE_OPTIONS` a run inherits, and a command or a script that sets `NODE_OPTIONS` without keeping that value —
 * `NODE_OPTIONS=--max-old-space-size=4096 npm test`, Jest's ESM `NODE_OPTIONS=--experimental-vm-modules jest` —
 * runs the tests without it. That is read from the command and from the script it runs, and said with how to keep
 * the value, and never as a runner's pool (the stranger campaign). A run in which no process wrote anything is said
 * as such: a process that loads the instrumentation writes as it ends, unless it ends abruptly having seen nothing.
 *
 * And what to add when the base failed on a checkout with no dependencies because `check` linked none into it:
 * `adviceForUnlinkedBase`, at the end.
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

/** A package manager running a script, after the variables a command may set for itself: `DATABASE_URL=… npm test`. */
const RUNS_SCRIPT = /^(?:\S+=\S*\s+)*(?!bun\s+test(?:\s|$))(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/;

/**
 * The package script a test command runs — `npm test`, `pnpm run test:e2e`, `DATABASE_URL=… yarn e2e` — or undefined
 * when it runs none. `bun test` is Bun's own runner, and not the script called `test`.
 */
export function scriptOf(command: string): string | undefined {
  return RUNS_SCRIPT.exec(command.trim())?.[1];
}

/**
 * `NODE_OPTIONS=…` in a command line, alone or after `export`, `cross-env` or `&&`, and the value it is given as
 * written: quoted, or up to where the shell would end the word.
 */
const SETS_NODE_OPTIONS = /(?:^|[\s;&|(])NODE_OPTIONS=("[^"]*"|'[^']*'|[^\s;&|)]*)/g;
/** What in that value keeps the one inherited: `$NODE_OPTIONS`, `${NODE_OPTIONS}`. */
const KEEPS_INHERITED = /\$\{?NODE_OPTIONS\b/;

interface Dropped {
  /** Where it is set: the test command, or the script it runs. */
  where: string;
  /** The value as written. */
  written: string;
  /** The same, without its quotes. */
  value: string;
}

/** The first `NODE_OPTIONS=` of the command, or of the script it runs, that does not keep the value inherited. */
function droppedNodeOptions(command: string, scripts: Readonly<Record<string, string>>): Dropped | undefined {
  const script = scriptOf(command);
  const texts: Array<[string, string | undefined]> = [
    ["the test command", command],
    [`the script "${script}", which the test command runs,`, script === undefined ? undefined : scripts[script]],
  ];
  for (const [where, text] of texts) {
    for (const [, written = ""] of text?.matchAll(SETS_NODE_OPTIONS) ?? []) {
      if (!KEEPS_INHERITED.test(written)) return { where, written, value: written.replace(/^(["'])(.*)\1$/s, "$2") };
    }
  }
  return undefined;
}

const NO_PROFILE = "the run left no profile";

const NOTHING_WROTE =
  "Most likely the instrumentation loaded in no process: check loads it through NODE_OPTIONS, and a process that " +
  'loads it writes as it ends. Something between the command and the tests sets NODE_OPTIONS without "$NODE_OPTIONS" ' +
  "in it — a script, a configuration, a runner that gives its processes an environment of its own —, or every process " +
  "ended abruptly, with process.exit(), before a request reached it.";

/** What the run of a side that left no profile was: what it ran, and how many processes wrote. */
export interface NoProfileRun {
  /** The test command, as the shell ran it. */
  command: string;
  /** The scripts of the `package.json` where it ran, for the one the command runs. */
  scripts: Readonly<Record<string, string>>;
  /** The processes that wrote anything into the run's file. */
  processes: number;
}

/** The failure of a run that left no profile: what is said of it, and what to do about it. */
export function noProfile(run: NoProfileRun): { message: string; advice: string } {
  const message = run.processes === 0 ? `${NO_PROFILE}: no process of it wrote anything` : NO_PROFILE;
  const dropped = droppedNodeOptions(run.command, run.scripts);
  if (dropped !== undefined) {
    // pnpm and yarn are Node.js programs, given the NODE_OPTIONS the run inherits: they write, around a script
    // that ran the tests without it. A run with processes and nothing in them is the same cause.
    const loaded =
      run.processes === 0 ? "The instrumentation loaded in no process" : "The tests ran without the instrumentation";
    const keep = `Keep it, with "$NODE_OPTIONS" in the value it sets${dropped.value === "" ? "" : `: NODE_OPTIONS="$NODE_OPTIONS ${dropped.value}"`}.`;
    return {
      message,
      advice:
        `${loaded}: ${dropped.where} sets NODE_OPTIONS=${dropped.written} without keeping the value it inherits, ` +
        `which is how check loads the instrumentation into every process. ${keep}`,
    };
  }
  if (run.processes === 0) {
    // The runner a command names is not ruled out by nothing having been written, and is named after it.
    const named = LOSING_RUNNERS.some((runner) => runner.matches.test(run.command));
    return { message, advice: named ? `${NOTHING_WROTE} ${adviceForNoProfile(run.command)}` : NOTHING_WROTE };
  }
  return { message, advice: adviceForNoProfile(run.command) };
}

/**
 * What a base that failed lacked, when it may be dependencies `check` did not link: with `prepare` given and `link`
 * unsaid, nothing is linked, on the reading that `prepare` installs the base's own. A `prepare` that only builds what
 * git ignores — hackathon-starter compiles its CSS in `postinstall`, and its base needs `npm run scss` — then fails
 * for want of the compiler, or leaves a base whose tests do (the stranger campaign).
 */
export interface UnlinkedBase {
  /** Whether the configuration gives `prepare`. */
  prepare: boolean;
  /** `check.link` as the configuration says it, undefined when it does not. */
  link: boolean | undefined;
  /** Whether the working tree has a `node_modules` in the project's directory, or above it to the top. */
  inWorkingTree: boolean;
  /** The same, in the base's checkout, after its `prepare`. */
  inBase: boolean;
  /** The file the configuration was read from, as the person reaches it from where `check` ran. */
  configFile: string;
}

/**
 * The sentence that points at `"link": true`, or undefined when that is not the likely cause: the base was linked,
 * the person said `false`, the base has dependencies of its own, or the working tree has none to link.
 */
export function adviceForUnlinkedBase(base: UnlinkedBase): string | undefined {
  if (!base.prepare || base.link !== undefined || base.inBase || !base.inWorkingTree) return undefined;
  return (
    'The base has no node_modules and the working tree has one: with "prepare" given, check links nothing into the ' +
    `base. If prepare does not install the dependencies, add "link": true to "check" in ${base.configFile}, and ` +
    "the working tree's are linked into the base before prepare runs."
  );
}
