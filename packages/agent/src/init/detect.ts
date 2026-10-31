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
 * Express, Koa (and Strapi, which runs on it), Fastify, Hono, Next.js, and NestJS on either of its platforms — Nest
 * serves through Express or Fastify, which name its routes. Elsewhere a request Node's server receives is still
 * observed, and its route is named by the shape of its path.
 */
export const FRAMEWORK_PACKAGES = [
  "express",
  "koa",
  "@strapi/strapi",
  "fastify",
  "hono",
  "@hapi/hapi",
  "next",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
] as const;

/**
 * The packages whose work inside a request the instrumentation observes, beside outgoing HTTP, which it always
 * does: Postgres through `pg` (and Prisma's adapter for it, and slonik, which query through it), through
 * postgres.js (`postgres`) and through Neon's driver over its WebSocket (and `@vercel/postgres` and Prisma's adapter for
 * Neon, which query through it; its `neon()` over `fetch` is a call), MySQL through `mysql2`, `mysql` and `mariadb` (and Prisma's adapter for it), SQL Server through
 * `tedious` (and `mssql` and Prisma's adapter, which query through it), SQLite through `better-sqlite3` (and Prisma's
 * adapter for it) and `libsql` (and `@libsql/client`, which opens a file with it) and `sqlite3` (Knex's and
 * Sequelize's), MongoDB through `mongodb` (and Mongoose, which sends every command through it), Prisma from 3.15
 * through its client (ADR 0241), Redis through `ioredis` and `redis` (node-redis, from 5.12), and MikroORM through the
 * driver each of its packages for a database brings. A
 * `pg` slonik brings nested under itself, where a package manager keeps it out of the application's root, is not
 * the one the instrumentation finds; one at the root, as npm hoists it, is.
 */
export const OBSERVED_PACKAGES = [
  "pg",
  "@prisma/adapter-pg",
  "slonik",
  "postgres",
  "@mikro-orm/postgresql",
  "@neondatabase/serverless",
  "@vercel/postgres",
  "@prisma/adapter-neon",
  "mysql2",
  "mysql",
  "@mikro-orm/mysql",
  "mariadb",
  "@prisma/adapter-mariadb",
  "tedious",
  "mssql",
  "@prisma/adapter-mssql",
  "better-sqlite3",
  "@prisma/adapter-better-sqlite3",
  "libsql",
  "@libsql/client",
  "sqlite3",
  "@mikro-orm/sqlite",
  "@mikro-orm/better-sqlite",
  "@mikro-orm/libsql",
  "mongodb",
  "mongoose",
  "@mikro-orm/mongodb",
  "@prisma/client",
  "ioredis",
  "redis",
] as const;

/**
 * Drivers whose work the instrumentation does not see at all: no diagnostics channel, no patch, and not HTTP, which
 * it would see as calls. A route with nothing observed, in a project that depends on one of them, is most likely a
 * route whose work went through it. Datastores first, then brokers:
 *
 * - a protocol of its own over a socket: Oracle's (`oracledb`), Cassandra's (`cassandra-driver`, ScyllaDB's too),
 *   Neo4j's Bolt (`neo4j-driver`), Memcached's (`memjs`, `memcached`), Kafka's (`kafkajs`), AMQP 0-9-1 (`amqplib`, and
 *   `amqp-connection-manager` on it), AMQP 1.0 (`@azure/service-bus`), MQTT (`mqtt`) and NATS (`nats`);
 * - a native binding, whose I/O is in C or C++: Couchbase's SDK (`couchbase`), and librdkafka's
 *   (`@confluentinc/kafka-javascript`, `node-rdkafka`);
 * - gRPC, which runs on `node:http2` and not on the channels the HTTP observer reads (undici's and `node:http`'s):
 *   Google Cloud's Firestore, Datastore, Spanner, Bigtable and Pub/Sub, and `firebase-admin`, whose Firestore is that
 *   one and whose Realtime Database is a WebSocket — what it asks of Firebase over HTTPS, its Auth, is seen as calls;
 *
 * A client over HTTP — PlanetScale's, Elasticsearch's, DynamoDB's, ClickHouse's, Upstash's, Supabase's — is not here
 * either, nor a queue on ioredis (BullMQ): those are observed, as calls and as Redis commands.
 */
export const UNOBSERVED_PACKAGES = [
  "oracledb",
  "cassandra-driver",
  "neo4j-driver",
  "couchbase",
  "@google-cloud/firestore",
  "firebase-admin",
  "@google-cloud/datastore",
  "@google-cloud/spanner",
  "@google-cloud/bigtable",
  "memjs",
  "memcached",
  "kafkajs",
  "@confluentinc/kafka-javascript",
  "node-rdkafka",
  "amqplib",
  "amqp-connection-manager",
  "@azure/service-bus",
  "mqtt",
  "nats",
  "@google-cloud/pubsub",
] as const;

/**
 * The packages of `UNOBSERVED_PACKAGES` a project depends on, and Prisma's driver adapters whose driver the
 * instrumentation does not observe: a client given one queries through that driver, and is left to its observer
 * (ADR 0241), so with `@prisma/adapter-planetscale` nothing is seen as a query.
 */
export function unobservedOf(
  dependencies: ReadonlySet<string>,
  ranges: ReadonlyMap<string, string> = new Map(),
): string[] {
  const unobserved: string[] = UNOBSERVED_PACKAGES.filter((name) => dependencies.has(name));
  for (const name of dependencies) {
    if (name.startsWith("@prisma/adapter-") && !(PRISMA_ADAPTERS as readonly string[]).includes(name)) {
      unobserved.push(name);
    }
  }
  for (const name of OBSERVED_PACKAGES) if (dependencies.has(name) && tooOld(name, ranges)) unobserved.push(name);
  return unobserved;
}

/** Prisma's driver adapters whose driver the instrumentation observes: with one, Prisma 7 queries through it. */
const PRISMA_ADAPTERS = [
  "@prisma/adapter-pg",
  "@prisma/adapter-neon",
  "@prisma/adapter-better-sqlite3",
  "@prisma/adapter-mariadb",
  "@prisma/adapter-mssql",
] as const;

/** The packages of `OBSERVED_PACKAGES` a project depends on, in a version the instrumentation observes. */
export function observedOf(
  dependencies: ReadonlySet<string>,
  ranges: ReadonlyMap<string, string> = new Map(),
): string[] {
  return OBSERVED_PACKAGES.filter((name) => dependencies.has(name) && !tooOld(name, ranges));
}

/**
 * The first version of a package the instrumentation observes, as `[major, minor]`, where it does not observe the ones
 * before: the MongoDB driver from 6, whose every command goes through one promise (ADR 0237), and so Mongoose from 8,
 * the first on it, and MikroORM's package for it from 6, which brings 6 — before them the driver answers through
 * callbacks, from whichever request gave its pool a connection back —; node-redis from 5.12, the first that publishes its commands on the diagnostics channel the
 * observer reads (`instrument/redis.ts`); Prisma's client from 3.15, the first read with the method its operations
 * go through (ADR 0241); and `mariadb` from 3, whose every query goes through the method its observer wraps from 3.0.1
 * on (`instrument/mariadb.ts`): a range pinned to 3.0.0, the one release before it, is the one read wrong.
 */
const OBSERVED_FROM: Readonly<Record<string, readonly [major: number, minor: number]>> = {
  "@prisma/client": [3, 15],
  mongodb: [6, 0],
  mongoose: [8, 0],
  "@mikro-orm/mongodb": [6, 0],
  redis: [5, 12],
  mariadb: [3, 0],
  // The shape `pg`'s patch reads — `pg`'s `Client` and `Pool`, exported — measured from 0.9 to 1.2.
  "@neondatabase/serverless": [0, 9],
};

/**
 * Whether the range a package is declared with cannot reach the first version observed: it starts at an earlier major
 * (`^5.7.7` of a package observed from 6: a caret does not cross a major), or at an earlier minor of the same major
 * and keeps the minor where it is (`~5.11.9`, `5.1.0` of one observed from 5.12). A range that lets the minor float
 * (`^5.1.0`, `^5`, `5.x`) installs a later minor as readily as an earlier one, and only the lockfile, which is not
 * read, would say which: it is taken as observed. A range that names no number — `latest`, `*`, a tag, a path — too.
 */
function tooOld(name: string, ranges: ReadonlyMap<string, string>): boolean {
  const from = OBSERVED_FROM[name];
  const range = (ranges.get(name) ?? "").trim();
  const start = /(\d+)(?:\.(\d+))?/.exec(range);
  if (from === undefined || start === null) return false;
  const [major, minor] = [Number(start[1]), Number(start[2] ?? 0)];
  if (major !== from[0]) return major < from[0];
  const floats = range.startsWith("^") || range.startsWith(">") || start[2] === undefined || /\.[x*]/i.test(range);
  return !floats && minor < from[1];
}

/**
 * The scripts that can be the test command, in the order they are preferred. An integration suite comes first, and
 * an end-to-end one next, because `check` judges what each request ran: a suite whose database is simulated
 * observes nothing, and its routes are not evaluated. NestJS's CLI writes `test:e2e` into every project it makes,
 * for the suite that calls the application in process with its real modules, and `test` for the unit one with
 * mocks: `test` first was the unit suite, in which no route runs anything (the stranger campaign of 2026-10-29).
 */
export const TEST_SCRIPTS = [
  "test:integration",
  "test-integration",
  "test:int",
  "integration",
  "test:e2e",
  "test-e2e",
  "e2e",
  "test",
] as const;

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
  /** The range each of them is declared with, as written. */
  ranges: Map<string, string>;
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
  const ranges = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const listed = value[field];
    if (listed === undefined) continue;
    if (!isRecord(listed)) return fail(`"${field}" must be an object`);
    for (const [name, range] of Object.entries(listed)) {
      dependencies.add(name);
      if (typeof range === "string") ranges.set(name, range);
    }
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
  return { ok: true, pkg: { dependencies, ranges, scripts, packageManager } };
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
  /** What its work goes through that the instrumentation does not observe (`unobservedOf`). */
  unobserved: string[];
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

/** Where Prisma looks for its schema when nothing says otherwise. */
const PRISMA_SCHEMAS = ["prisma/schema.prisma", "schema.prisma"] as const;

/**
 * Whether the project's Prisma client is one the instrumentation cannot reach: the `prisma-client` generator's, before
 * 7, on Prisma's own engine — what `prisma init` writes in 6.19. It imports Prisma's runtime as an ES module, and
 * nothing outside that module holds the class (ADR 0243). On 7, and with `engineType = "client"`, the client queries
 * through a driver adapter, which is observed through its driver or named among the unobserved. A range that names no
 * major, or a schema that is not where Prisma looks by default, says nothing.
 */
async function prismaClientUnreachable(dir: string, ranges: ReadonlyMap<string, string>): Promise<boolean> {
  const major = /(\d+)/.exec(ranges.get("@prisma/client") ?? "");
  if (major === null || Number(major[1]) >= 7) return false;
  for (const path of PRISMA_SCHEMAS) {
    const text = await readIfThere(join(dir, path));
    if (text === undefined) continue;
    const code = text.replace(/\/\/.*$/gm, "");
    return [...code.matchAll(/\bgenerator\s+\w+\s*\{([^}]*)\}/g)].some(
      ([, body = ""]) => /\bprovider\s*=\s*"prisma-client"/.test(body) && !/\bengineType\s*=\s*"client"/.test(body),
    );
  }
  return false;
}

/** Looks at the project in `dir`, whose `package.json` has already been read. */
export async function detect(dir: string, pkg: PackageJson): Promise<Detection> {
  const top = await repositoryTop(dir);
  const manager = packageManagerOf(pkg.packageManager, await lockfileManager(dir, top));
  const testScript = testScriptOf(pkg.scripts);
  const frameworks = FRAMEWORK_PACKAGES.filter((name) => pkg.dependencies.has(name));
  let observed = observedOf(pkg.dependencies, pkg.ranges);
  const unobserved = unobservedOf(pkg.dependencies, pkg.ranges);
  if (observed.includes("@prisma/client") && (await prismaClientUnreachable(dir, pkg.ranges))) {
    observed = observed.filter((name) => name !== "@prisma/client");
    unobserved.push("@prisma/client");
  }
  return {
    manager,
    frameworks,
    observed,
    unobserved,
    testScript,
    testCommand: testScript === undefined ? undefined : commandFor(manager, testScript),
    installed: pkg.dependencies.has(AGENT_PACKAGE),
    repository: top !== undefined,
    next: pkg.dependencies.has("next") ? await nextBuild(dir) : undefined,
  };
}
