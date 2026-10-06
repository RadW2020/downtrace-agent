import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shellJoin } from "../check/config.ts";

/**
 * What `downtrace init` reads of a project, and nothing else: its `package.json`, the lockfile that says which
 * package manager installs it, its `next.config` and its `tsconfig.json`. Files on this machine only — no
 * registry, no network, no process started: locally there is no cloud, and the answer is the same offline.
 */

/** This package, as a project depends on it. */
export const AGENT_PACKAGE = "@downtrace/agent";

/**
 * The packages that say a project runs a framework whose routes the instrumentation names by their templates:
 * Express, Koa (and Strapi, which runs on it) and Next.js. Elsewhere a request is still observed, through
 * `node:http`, and its route is named by the shape of its path.
 */
export const FRAMEWORK_PACKAGES = ["express", "koa", "@strapi/strapi", "next"] as const;

/**
 * The packages whose work inside a request the instrumentation observes, beside outgoing HTTP, which it always
 * does: Postgres through `pg` (and Prisma's adapter for it), MySQL through `mysql2`, Redis through `ioredis`.
 */
export const OBSERVED_PACKAGES = ["pg", "@prisma/adapter-pg", "mysql2", "ioredis"] as const;

/**
 * The scripts that can be the test command, in the order they are preferred. An integration suite comes first
 * because `check` judges what each request ran: a suite whose database is simulated observes nothing, and its
 * routes are not evaluated.
 */
export const TEST_SCRIPTS = ["test:integration", "test-integration", "test:int", "integration", "test"] as const;

/** What `npm init` writes as the test script, which is no test at all. */
const NPM_PLACEHOLDER = /no test specified/;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
const MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

/** The lockfile of each package manager, in the order they are looked for. */
export const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** The names Next.js reads its configuration from. */
export const NEXT_CONFIGS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
];

/** The names Next.js reads an instrumentation hook from, at the root of the project or in `src/`. */
const INSTRUMENTATION_NAMES = [
  "instrumentation.ts",
  "instrumentation.js",
  "instrumentation.mjs",
  "instrumentation.mts",
];

/** The values of `moduleResolution` that ignore a package's `exports`, and so cannot resolve `/register`. */
export const UNRESOLVING = ["node", "node10", "classic"];

/** What the import of the instrumentation is spelled as, wherever a project already writes it. */
export const REGISTER_SPECIFIER = `${AGENT_PACKAGE}/register`;

/** The parts of `package.json` that `init` reads. */
export interface PackageJson {
  /** Every package in `dependencies`, `devDependencies` and `optionalDependencies`. */
  dependencies: Set<string>;
  scripts: Record<string, string>;
  /** The `packageManager` field (Corepack's), as written. */
  packageManager: string | undefined;
}

export type PackageResult = { ok: true; pkg: PackageJson } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the text of a `package.json`. Pure: the file is read by whoever calls it. */
export function parsePackageJson(text: string, source: string): PackageResult {
  const fail = (reason: string): PackageResult => ({ ok: false, reason: `${source}: ${reason}` });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return fail(`not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(value)) return fail("it must be a JSON object");

  const dependencies = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const listed = value[field];
    if (listed === undefined) continue;
    if (!isRecord(listed)) return fail(`"${field}" must be an object`);
    for (const name of Object.keys(listed)) dependencies.add(name);
  }

  const scripts: Record<string, string> = {};
  if (value.scripts !== undefined) {
    if (!isRecord(value.scripts)) return fail('"scripts" must be an object');
    for (const [name, body] of Object.entries(value.scripts)) {
      if (typeof body === "string") scripts[name] = body;
    }
  }

  const packageManager = value.packageManager;
  if (packageManager !== undefined && typeof packageManager !== "string") {
    return fail('"packageManager" must be a string');
  }
  return { ok: true, pkg: { dependencies, scripts, packageManager } };
}

/** The script to run as the test command, or undefined when there is none. */
export function testScriptOf(scripts: Record<string, string>): string | undefined {
  return TEST_SCRIPTS.find((name) => {
    const body = scripts[name];
    return body !== undefined && body.trim() !== "" && !NPM_PLACEHOLDER.test(body);
  });
}

/** The package manager the project names in `packageManager`, else the one its lockfile is of, else npm. */
export function packageManagerOf(field: string | undefined, lockfile: PackageManager | undefined): PackageManager {
  const named = MANAGERS.find((manager) => field?.startsWith(`${manager}@`));
  return named ?? lockfile ?? "npm";
}

/** How a person runs that script with that package manager. `bun test` is Bun's runner, not the script. */
export function commandFor(manager: PackageManager, script: string): string {
  if (script === "test" && manager !== "bun") return `${manager} test`;
  return shellJoin([manager, "run", script]);
}

/**
 * Whether a `next.config` asks for `output: "standalone"`, read from its text and never run. Any quoted
 * `standalone` counts, so that a value chosen by a condition (`output: ci ? "standalone" : undefined`) is seen:
 * an instrumentation hook in a build that turns out not to prune works just the same.
 */
export function asksForStandalone(text: string): boolean {
  return /(["'`])standalone\1/.test(text);
}

/** The `moduleResolution` a `tsconfig.json` sets, read from its text: it may carry comments, which JSON refuses. */
export function moduleResolutionOf(text: string): string | undefined {
  return /"moduleResolution"\s*:\s*"([^"]+)"/.exec(text)?.[1];
}

/** Where Next.js looks for the instrumentation hook, and what is there. */
export interface NextBuild {
  /** The configuration that asks for `output: "standalone"`. */
  config: string;
  /** Where the hook goes, relative to the project: `instrumentation.ts`, or `src/instrumentation.js`. */
  target: string;
  /** An instrumentation hook the project already has, and whether it imports the instrumentation. */
  existing: { path: string; loads: boolean } | undefined;
  /** A `moduleResolution` of `tsconfig.json` that cannot resolve `/register`, when it sets one. */
  unresolving: string | undefined;
}

/** Everything `init` found. */
export interface Detection {
  manager: PackageManager;
  /** The packages of `FRAMEWORK_PACKAGES` the project depends on. */
  frameworks: string[];
  /** The packages of `OBSERVED_PACKAGES` the project depends on. */
  observed: string[];
  testScript: string | undefined;
  testCommand: string | undefined;
  /** Whether the project depends on this package, which decides how a command of it is spelled. */
  installed: boolean;
  /** Whether a git repository holds the project: `check` compares the working tree against a commit. */
  repository: boolean;
  /** Present when the project is a Next.js build that prunes what nothing imports. */
  next: NextBuild | undefined;
}

/** Reads a file of the project, or undefined when it is not there. */
export async function readIfThere(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/** The directory of the git repository that holds `dir` (the one with `.git` in it), or undefined. */
async function repositoryTop(dir: string): Promise<string | undefined> {
  for (let at = dir; ; at = dirname(at)) {
    if (await exists(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

/**
 * The package manager of the nearest lockfile: in the project, or above it up to the top of its repository, which
 * is where a workspace keeps the one lockfile of all its packages. Outside a repository, only the project's own.
 */
async function lockfileManager(dir: string, top: string | undefined): Promise<PackageManager | undefined> {
  for (let at = dir; ; at = dirname(at)) {
    for (const [name, manager] of LOCKFILES) {
      if (await exists(join(at, name))) return manager;
    }
    if (top === undefined || at === top || dirname(at) === at) return undefined;
  }
}

async function nextBuild(dir: string): Promise<NextBuild | undefined> {
  let config: string | undefined;
  for (const name of NEXT_CONFIGS) {
    const text = await readIfThere(join(dir, name));
    if (text !== undefined && asksForStandalone(text)) {
      config = name;
      break;
    }
  }
  if (config === undefined) return undefined;

  let existing: NextBuild["existing"];
  for (const folder of ["", "src"]) {
    for (const name of INSTRUMENTATION_NAMES) {
      const path = folder === "" ? name : `${folder}/${name}`;
      const text = await readIfThere(join(dir, path));
      if (text !== undefined && existing === undefined) existing = { path, loads: text.includes(REGISTER_SPECIFIER) };
    }
  }

  // Next reads the hook from `src/` when the application is there, and from the root otherwise.
  const atRoot = (await exists(join(dir, "app"))) || (await exists(join(dir, "pages")));
  const inSrc = !atRoot && ((await exists(join(dir, "src", "app"))) || (await exists(join(dir, "src", "pages"))));
  const tsconfig = await readIfThere(join(dir, "tsconfig.json"));
  const name = tsconfig === undefined ? "instrumentation.js" : "instrumentation.ts";
  const resolution = tsconfig === undefined ? undefined : moduleResolutionOf(tsconfig);
  return {
    config,
    target: inSrc ? `src/${name}` : name,
    existing,
    unresolving: resolution !== undefined && UNRESOLVING.includes(resolution.toLowerCase()) ? resolution : undefined,
  };
}

/** Looks at the project in `dir`, whose `package.json` has already been read. */
export async function detect(dir: string, pkg: PackageJson): Promise<Detection> {
  const top = await repositoryTop(dir);
  const manager = packageManagerOf(pkg.packageManager, await lockfileManager(dir, top));
  const testScript = testScriptOf(pkg.scripts);
  const frameworks = FRAMEWORK_PACKAGES.filter((name) => pkg.dependencies.has(name));
  return {
    manager,
    frameworks,
    observed: OBSERVED_PACKAGES.filter((name) => pkg.dependencies.has(name)),
    testScript,
    testCommand: testScript === undefined ? undefined : commandFor(manager, testScript),
    installed: pkg.dependencies.has(AGENT_PACKAGE),
    repository: top !== undefined,
    next: pkg.dependencies.has("next") ? await nextBuild(dir) : undefined,
  };
}
