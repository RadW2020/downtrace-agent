/**
 * Starting the instrumentation: from the environment, which is what `register` does, or from the application's own
 * code, with `init()` (DT-133).
 *
 * `init()` goes in an instrument file the application loads before anything else: `require("./instrument")` as the
 * first line of a CommonJS entry, `node --import ./instrument.mjs` for ES modules, whose static imports are all loaded
 * before any of the entry's code runs. Its options win, and the environment fills what they leave out (RF-103).
 */
import { createRequire } from "node:module";
import { createAgent } from "./agent.ts";
import { type ConfigResult, configFromCode, type InitOptions } from "./config.ts";
import { applicationEntry } from "./entry.ts";
import { createLogger, type Logger } from "./log.ts";
import { unsupportedNode } from "./node-floor.ts";
import { registered, remember } from "./registered.ts";

/**
 * Starts the instrumentation a configuration describes, or says once why it does not. What `register` runs and what
 * `init()` runs, so the two start the same instrumentation.
 */
export function activate(result: ConfigResult): boolean {
  if (!result.ok) {
    createLogger(false).warn(`instrumentation disabled: ${result.reason}`);
    return false;
  }
  const log = createLogger(result.config.debug);
  for (const warning of result.warnings) log.warn(warning);
  const agent = createAgent(result.config, { log, handleSignals: true });
  agent.start();
  // A start that failed has said why and left nothing running: there is no instrumentation to remember (DT-168).
  if (agent.stats.disabled) return false;
  // So an application that calls `process.exit()` can wait for it: that call fires nothing and waits for
  // nothing, and without this the last flush is simply cut (gh-383).
  remember(agent);
  return true;
}

/**
 * Starts the instrumentation from the application's code, with `options` and the environment for what they leave out:
 *
 * ```js
 * // instrument.js, required by the entry's first line
 * const { init } = require("@downtrace/agent");
 * init({ dsn: "https://dt_…@downtrace.example.com" });
 * ```
 *
 * Without a DSN, or a token and a URL, it says so once and does nothing else (RF-104). A process has one
 * instrumentation: a second call, or one after `--import @downtrace/agent/register` started it, changes nothing and
 * says so (RF-105). It never throws into the application (invariant 2).
 */
export function init(options?: InitOptions): void {
  const log = createLogger(false);
  try {
    // As `register` does, before anything else: below the floor, one warning and nothing more (DT-131).
    const unsupported = unsupportedNode(process.versions.node);
    if (unsupported !== undefined) {
      log.warn(`instrumentation disabled: ${unsupported}`);
      return;
    }
    if (registered() !== undefined) {
      log.warn("init() starts nothing: this process already runs the instrumentation, and keeps its settings");
      return;
    }
    const result = configFromCode(options);
    // Looked at before the start, which loads some of them itself: Express, to record its mounts from then on.
    const late = result.ok
      ? loadedBefore(applicationEntry({ preserveSymlinksMain: result.config.preserveSymlinksMain }))
      : [];
    if (activate(result)) sayLate(late, log);
  } catch (err) {
    log.warn(`instrumentation disabled: init() failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * What a late `init()` cannot observe, found by trying it (DT-133): nothing the application only loaded. A library in
 * the module cache is wrapped where it is, and what the application does with it after `init()` is observed as if
 * `init()` had come first. What is lost is what the application built with some of them before `init()`, from
 * where the instrumentation cannot reach it afterwards:
 *
 * - Express: a router mounted before is named without its mount path (`/:param/users/:id` for `/api/users/:id`): the
 *   mount is recorded as it is made (`mounts.ts`).
 * - Fastify: an instance created before is never announced to the instrumentation, and its routes are named by the
 *   shape of their paths, so a word in one travels (`fastify.ts`).
 * - `mssql`: a pool built before keeps the validation it bound (`watchMssql`).
 * - Prisma's adapter for MariaDB: one connected before is not observed (`watchPrismaMariadb`).
 *
 * Whether the application built anything with them cannot be known from here; whether it loaded them can, and loading
 * one before `init()` is what makes building with it before `init()` possible. So the warning names what was loaded,
 * and says what building with it before would lose.
 */
const BUILT_BEFORE: ReadonlyArray<{ name: string; loses: string }> = [
  { name: "express", loses: "a router mounted before init() is named without its mount path" },
  { name: "fastify", loses: "a Fastify instance created before init() names its routes by the shape of their paths" },
  { name: "mssql", loses: "an mssql pool built before init() is not observed" },
  { name: "@prisma/adapter-mariadb", loses: "a Prisma adapter for MariaDB connected before init() is not observed" },
];

/** The libraries of `BUILT_BEFORE` the application has loaded already, resolved from its entry. Loads nothing. */
function loadedBefore(entry: string): ReadonlyArray<{ name: string; loses: string }> {
  let require: NodeJS.Require;
  try {
    require = createRequire(entry);
  } catch {
    return [];
  }
  return BUILT_BEFORE.filter(({ name }) => {
    try {
      return require.cache[require.resolve(name)] !== undefined;
    } catch {
      return false; // The application does not have it.
    }
  });
}

function sayLate(late: ReadonlyArray<{ name: string; loses: string }>, log: Logger): void {
  if (late.length === 0) return;
  const names = late.map(({ name }) => name).join(", ");
  const loses = late.map(({ loses }) => loses).join("; ");
  log.warn(`init() ran after the application loaded ${names}: ${loses}. Load the instrument file before anything else`);
}
