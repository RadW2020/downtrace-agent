import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The three ways a runner says a module was not found: Node's CommonJS message, followed by its require stack, whose
 * first file is the one that asked (Vitest writes it too, for a `require`); the ESM message, Node's with the path and
 * Vitest's with the spec, followed by the file that imported it; and Jest's, with that file relative to where it runs.
 */
const NOT_FOUND = [
  /Cannot find module '([^']+)'\s*\n\s*Require stack:\s*\n\s*- ([^\n]+)/g,
  /Cannot find module '([^']+)' imported from '?([^'\s]+)'?/g,
  /Cannot find module '([^']+)' from '([^']+)'/g,
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: the colours a runner writes are control characters.
const COLOURS = /\u001b\[[0-9;]*m/g;

/**
 * The files a failed run's output says it could not find, as absolute paths, in the order it says them: a relative
 * spec from the directory of the file that asked for it, an absolute one or a `file:` URL as it is, and the file
 * itself from `cwd` when the runner wrote it relative (Jest). A bare name is a package, which the dependencies answer
 * for and a build does not: left out, as is a builtin.
 */
export function missingModulesIn(output: string, cwd: string): string[] {
  const text = output.replace(COLOURS, "");
  const found: string[] = [];
  for (const pattern of NOT_FOUND) {
    for (const [, spec = "", from = ""] of text.matchAll(pattern)) {
      const asker = path.resolve(cwd, from.trim());
      let missing: string | undefined;
      if (spec.startsWith("file:")) {
        try {
          missing = fileURLToPath(spec);
        } catch {
          missing = undefined;
        }
      } else if (path.isAbsolute(spec)) {
        missing = spec;
      } else if (spec.startsWith("./") || spec.startsWith("../")) {
        missing = path.resolve(path.dirname(asker), spec);
      }
      if (missing !== undefined && !found.includes(missing)) found.push(missing);
    }
  }
  return found;
}

/** What the base lacked that the working tree has, of what its run could not find. */
export interface UnbuiltBase {
  /**
   * The first directory or file on the way to it that the base lacks, from the top of the repository, as the sentence
   * writes it: a directory ends in its `/` (`lib/`).
   */
  missing: string;
  /** The project's own `build` script, as its package manager runs it, or undefined when it has none. */
  build: string | undefined;
  /** Whether the configuration gives `prepare`. */
  prepare: boolean;
  /** The file the configuration was read from, as the person reaches it from where `check` ran. */
  configFile: string;
}

/**
 * The sentence for a base whose tests asked for what a build makes: a file git ignores and the working tree has, which
 * a fresh checkout does not (Parse Server's specs require `lib/`, its Babel build). `prepare` builds it; with `link`,
 * on the working tree's dependencies, since a build needs its compiler and installs nothing.
 */
export function adviceForUnbuiltBase(base: UnbuiltBase): string {
  const missing = base.missing;
  if (base.prepare) {
    return `The base has no ${missing}, which the working tree has: prepare ran and did not make it. The tests ask for it, so "prepare" in ${base.configFile} has to build it.`;
  }
  const build = base.build ?? `<the command that builds ${missing}>`;
  return (
    `The base has no ${missing}, which the working tree has and git does not keep: a fresh checkout lacks what a build ` +
    `makes, and the tests ask for it. Add "prepare": "${build}" and "link": true to "check" in ${base.configFile}: the ` +
    "working tree's dependencies are linked into the base, and prepare builds it there before the tests run."
  );
}

/**
 * The observers of a dependency, and the packages that, among the project's dependencies, mean the observer should have
 * found a driver: `pg`'s through Prisma's adapter, slonik and postgres.js too, MySQL's through `mariadb` and Prisma's
 * adapter for it, SQLite's through what brings libsql or better-sqlite3, and each database's MikroORM package. The
 * packages are `OBSERVED_PACKAGES`'s, each under its observer. Every switch of `INSTRUMENTS` but `http` and
 * `runtime`, which need no driver.
 */
export const OBSERVER_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  pg: ["pg", "@prisma/adapter-pg", "slonik", "postgres", "@mikro-orm/postgresql"],
  mysql: ["mysql2", "@mikro-orm/mysql", "mariadb", "@prisma/adapter-mariadb"],
  sqlite: [
    "better-sqlite3",
    "@prisma/adapter-better-sqlite3",
    "libsql",
    "@libsql/client",
    "sqlite3",
    "@mikro-orm/sqlite",
    "@mikro-orm/better-sqlite",
    "@mikro-orm/libsql",
  ],
  mongodb: ["mongodb", "mongoose", "@mikro-orm/mongodb"],
  prisma: ["@prisma/client"],
  redis: ["ioredis", "redis"],
};

/** An observer of a run that did not find a driver, and the packages the project depends on that it was for. */
export interface UnseenObserver {
  observer: string;
  /** `unavailable` as `pg` says it, or `absent`: left out, as every other observer says it (ADR 0240). */
  state: "unavailable" | "absent";
  packages: string[];
}

/**
 * The observers of a run, as `observers` merged them, that did not find a driver the project depends on: what that
 * database did is absent from the run, not zero. Every observer but `pg` leaves its key out when it found none, which
 * the batch reads as «did not say» because the instrumentation cannot tell a database the application does not use;
 * `check` reads the project's dependencies, and can. And `pg`'s `unavailable`, said in every application with no
 * Postgres, is said here only for one that depends on it. Without the dependencies (no `package.json` where `check`
 * ran), what said `unavailable` is all there is to go on. A run that said nothing of any observer is not read.
 */
export function unseenObservers(
  observers: Readonly<Record<string, string>>,
  dependencies: ReadonlySet<string> | undefined,
): UnseenObserver[] {
  if (Object.keys(observers).length === 0) return [];
  const unseen: UnseenObserver[] = [];
  for (const [observer, packages] of Object.entries(OBSERVER_PACKAGES)) {
    const said = observers[observer];
    const unavailable = said?.split("/").includes("unavailable") === true;
    if (said !== undefined && !unavailable) continue;
    const state = unavailable ? "unavailable" : "absent";
    if (dependencies === undefined) {
      if (unavailable) unseen.push({ observer, state, packages: [] });
      continue;
    }
    const declared = packages.filter((name) => dependencies.has(name));
    if (declared.length > 0) unseen.push({ observer, state, packages: declared });
  }
  return unseen;
}
