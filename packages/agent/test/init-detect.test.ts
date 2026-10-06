import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asksForStandalone,
  commandFor,
  detect,
  LOCKFILES,
  moduleResolutionOf,
  NEXT_CONFIGS,
  type PackageJson,
  packageManagerOf,
  parsePackageJson,
  TEST_SCRIPTS,
  testScriptOf,
} from "../src/init/detect.ts";

/**
 * What `downtrace init` reads of a project: its package.json, its lockfile, its next.config and its tsconfig.json,
 * from files on this machine and nothing else.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A project in a directory of its own, with `files` in it; `.git` makes it a repository, as git would see it. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-init-detect-")));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    if (path.endsWith("/")) await mkdir(join(dir, path), { recursive: true });
    else await writeFile(join(dir, path), text);
  }
  return dir;
}

function pkg(value: Record<string, unknown>): PackageJson {
  const parsed = parsePackageJson(JSON.stringify(value), "package.json");
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.pkg;
}

describe("reading package.json", () => {
  it("reads the dependencies of every kind, the scripts and the package manager", () => {
    const read = pkg({
      dependencies: { express: "^5" },
      devDependencies: { vitest: "^4" },
      optionalDependencies: { ioredis: "^5" },
      scripts: { test: "vitest run", odd: 3 },
      packageManager: "pnpm@11.20.0",
    });
    expect([...read.dependencies].sort()).toEqual(["express", "ioredis", "vitest"]);
    expect(read.scripts).toEqual({ test: "vitest run" });
    expect(read.packageManager).toBe("pnpm@11.20.0");
  });

  it.each([
    ["not JSON", "{nope", "not JSON"],
    ["a list", "[]", "must be a JSON object"],
    ["dependencies that are a list", '{"dependencies":["express"]}', '"dependencies" must be an object'],
    ["scripts that are a string", '{"scripts":"vitest"}', '"scripts" must be an object'],
    ["a packageManager that is a number", '{"packageManager":9}', '"packageManager" must be a string'],
  ])("refuses %s, and says where", (_what, text, reason) => {
    const parsed = parsePackageJson(text, "/p/package.json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("/p/package.json: ");
    expect(parsed.reason).toContain(reason);
  });
});

describe("the test script", () => {
  it.each(TEST_SCRIPTS.map((name, rank) => [name, rank] as const))(
    "takes %s over every script after it in the list",
    (name, rank) => {
      const scripts = Object.fromEntries(TEST_SCRIPTS.slice(rank).map((each) => [each, `run ${each}`]));
      expect(testScriptOf(scripts)).toBe(name);
    },
  );

  it("prefers the integration suite to the unit one: what check judges is what each request ran", () => {
    expect(testScriptOf({ test: "vitest run", "test:integration": "vitest run -c integration" })).toBe(
      "test:integration",
    );
  });

  it("is none for npm's placeholder, an empty script, or scripts with no test in them", () => {
    expect(testScriptOf({ test: 'echo "Error: no test specified" && exit 1' })).toBeUndefined();
    expect(testScriptOf({ test: "  " })).toBeUndefined();
    expect(testScriptOf({ build: "tsc", start: "node ." })).toBeUndefined();
  });
});

describe("the package manager and the command", () => {
  it("is the one packageManager names, then the lockfile's, then npm", () => {
    expect(packageManagerOf("pnpm@11.20.0", "npm")).toBe("pnpm");
    expect(packageManagerOf("yarn@4.1.0", undefined)).toBe("yarn");
    expect(packageManagerOf(undefined, "bun")).toBe("bun");
    expect(packageManagerOf("deno@2", "yarn")).toBe("yarn");
    expect(packageManagerOf(undefined, undefined)).toBe("npm");
  });

  it("spells the command as a person runs it", () => {
    expect(commandFor("npm", "test")).toBe("npm test");
    expect(commandFor("npm", "test:integration")).toBe("npm run test:integration");
    expect(commandFor("pnpm", "test")).toBe("pnpm test");
    expect(commandFor("yarn", "integration")).toBe("yarn run integration");
    // `bun test` is Bun's own runner, which is not the project's script.
    expect(commandFor("bun", "test")).toBe("bun run test");
  });

  it.each(LOCKFILES.map(([file, manager]) => [file, manager] as const))("reads %s as %s", async (file, manager) => {
    const dir = await project({ "package.json": "{}", [file]: "" });
    expect((await detect(dir, pkg({}))).manager).toBe(manager);
  });

  it("finds the lockfile of a workspace at the top of the repository, and none above a project outside one", async () => {
    const top = await project({ ".git/": "", "pnpm-lock.yaml": "", "services/api/package.json": "{}" });
    expect((await detect(join(top, "services/api"), pkg({}))).manager).toBe("pnpm");
    const loose = await project({ "pnpm-lock.yaml": "", "api/package.json": "{}" });
    expect((await detect(join(loose, "api"), pkg({}))).manager).toBe("npm");
  });
});

describe("what the project runs", () => {
  it("names the frameworks and the observed dependencies it depends on, and nothing else", async () => {
    const dir = await project({ ".git/": "" });
    const found = await detect(
      dir,
      pkg({ dependencies: { express: "^5", pg: "^8", ioredis: "^5", mongoose: "^8", lodash: "^4" } }),
    );
    expect(found.frameworks).toEqual(["express"]);
    expect(found.observed).toEqual(["pg", "ioredis"]);
    expect(found.repository).toBe(true);
    expect(found.next).toBeUndefined();
  });

  it("knows Strapi runs on Koa, and Prisma's adapter goes through pg", async () => {
    const found = await detect(
      await project({}),
      pkg({ dependencies: { "@strapi/strapi": "^5", "@prisma/adapter-pg": "^7", mysql2: "^3" } }),
    );
    expect(found.frameworks).toEqual(["@strapi/strapi"]);
    expect(found.observed).toEqual(["@prisma/adapter-pg", "mysql2"]);
    expect(found.repository).toBe(false);
  });

  it("says whether this package is installed, which decides how its commands are spelled", async () => {
    const dir = await project({});
    expect((await detect(dir, pkg({ devDependencies: { "@downtrace/agent": "^0.9" } }))).installed).toBe(true);
    expect((await detect(dir, pkg({ dependencies: { express: "^5" } }))).installed).toBe(false);
  });
});

describe("a Next.js build that prunes", () => {
  it("reads output: standalone from the configuration's text, however it is quoted or chosen", () => {
    expect(asksForStandalone('const c = { output: "standalone" };')).toBe(true);
    expect(asksForStandalone("module.exports = { output: 'standalone' }")).toBe(true);
    expect(asksForStandalone('output: process.env.CI ? "standalone" : undefined')).toBe(true);
    expect(asksForStandalone('const c = { output: "export" };')).toBe(false);
    expect(asksForStandalone("// a standalone comment")).toBe(false);
  });

  it.each(NEXT_CONFIGS)("finds it in %s", async (config) => {
    const dir = await project({ [config]: 'export default { output: "standalone" };', "tsconfig.json": "{}" });
    expect((await detect(dir, pkg({ dependencies: { next: "15" } }))).next).toMatchObject({
      config,
      target: "instrumentation.ts",
    });
  });

  it("is not looked for without next, nor without standalone", async () => {
    const dir = await project({ "next.config.mjs": 'export default { output: "standalone" };' });
    expect((await detect(dir, pkg({ dependencies: { express: "5" } }))).next).toBeUndefined();
    const plain = await project({ "next.config.mjs": "export default {};" });
    expect((await detect(plain, pkg({ dependencies: { next: "15" } }))).next).toBeUndefined();
  });

  it("puts the hook in src/ when the application is there, and writes it in JavaScript without a tsconfig.json", async () => {
    const config = 'module.exports = { output: "standalone" };';
    const next = pkg({ dependencies: { next: "15" } });
    const inSrc = await project({ "next.config.js": config, "src/app/": "", "tsconfig.json": "{}" });
    expect((await detect(inSrc, next)).next?.target).toBe("src/instrumentation.ts");
    const atRoot = await project({ "next.config.js": config, "app/": "", "src/app/": "" });
    expect((await detect(atRoot, next)).next?.target).toBe("instrumentation.js");
  });

  it("finds a hook the project already has, and whether it loads the instrumentation", async () => {
    const config = 'module.exports = { output: "standalone" };';
    const next = pkg({ dependencies: { next: "15" } });
    const theirs = await project({
      "next.config.js": config,
      "src/instrumentation.ts": "export function register() {}",
    });
    expect((await detect(theirs, next)).next?.existing).toEqual({ path: "src/instrumentation.ts", loads: false });
    const ours = await project({
      "next.config.js": config,
      "instrumentation.js": 'export async function register() { await import("@downtrace/agent/register"); }',
    });
    expect((await detect(ours, next)).next?.existing).toEqual({ path: "instrumentation.js", loads: true });
  });

  it("reads a moduleResolution that cannot resolve /register, comments and all", async () => {
    expect(moduleResolutionOf('{\n  // old\n  "compilerOptions": { "moduleResolution": "node" }\n}')).toBe("node");
    expect(moduleResolutionOf('{"compilerOptions": {}}')).toBeUndefined();
    const config = 'module.exports = { output: "standalone" };';
    const next = pkg({ dependencies: { next: "15" } });
    for (const [value, unresolving] of [
      ["node", "node"],
      ["Node10", "Node10"],
      ["bundler", undefined],
      ["nodenext", undefined],
    ] as const) {
      const dir = await project({
        "next.config.js": config,
        "tsconfig.json": `{ "compilerOptions": { "moduleResolution": "${value}" } }`,
      });
      expect((await detect(dir, next)).next?.unresolving, value).toBe(unresolving);
    }
  });
});
