import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findConfig, parseConfig } from "../src/check/config.ts";
import type { CheckReport } from "../src/check/report.ts";
import { runInit } from "../src/init/command.ts";
import { INSTRUMENTATION_FILE } from "../src/init/files.ts";
import type { InitReport } from "../src/init/report.ts";
import { APP, cleanEnv, createProject, downtrace, type Project } from "./support/check-project.ts";

/**
 * `downtrace init`: configures a project with no question a coding agent cannot answer (ADO-01). It writes the test
 * command where `check` reads it and the hook a pruning Next.js build needs, says what it could not detect and what
 * to do instead, makes no network request, and run twice writes nothing twice and keeps what a person wrote.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const dirs: string[] = [];
const projects: Project[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  for (const made of projects.splice(0)) await made.cleanup();
});

/** A project in a directory of its own. `.git/` makes it a repository as init sees one; a path ending in / is a directory. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-init-")));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    if (path.endsWith("/")) await mkdir(join(dir, path), { recursive: true });
    else await writeFile(join(dir, path), text);
  }
  return dir;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const EXPRESS_PG = json({
  name: "shop",
  dependencies: { express: "^5.2.1", pg: "^8.23.0" },
  devDependencies: { vitest: "^4.1.11" },
  scripts: { test: "vitest run", "test:integration": "vitest run --config vitest.integration.ts" },
});

const NEXT_APP = (extra: Record<string, unknown> = {}): string =>
  json({
    name: "store",
    dependencies: { next: "15.5.4", pg: "^8.23.0", "@downtrace/agent": "^0.9.0", ...extra },
    scripts: { test: "vitest run" },
  });

async function init(dir: string): Promise<{ code: number; report: InitReport }> {
  const out: string[] = [];
  const code = await runInit({ cwd: dir, json: true, stdout: (text) => out.push(text) });
  return { code, report: JSON.parse(out.join("")) as InitReport };
}

async function initText(dir: string): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const code = await runInit({ cwd: dir, json: false, stdout: (text) => out.push(text) });
  return { code, text: out.join("") };
}

/** Every file under `dir` with its content: what a person could tell had been written. */
async function contents(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(dir.length + 1)] = await readFile(path, "utf8");
    }
  }
  return files;
}

describe("a project it can configure", () => {
  it("writes the integration test command of an Express and pg project where check reads it", async () => {
    const dir = await project({ ".git/": "", "package.json": EXPRESS_PG });
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(report).toMatchObject({
      schema: "downtrace-init/1",
      status: "configured",
      project: dir,
      detected: {
        packageManager: "npm",
        frameworks: ["express"],
        observed: ["pg"],
        testScript: "test:integration",
        testCommand: "npm run test:integration",
        bundler: null,
      },
      command: "npm run test:integration",
      files: [{ path: "downtrace.json", action: "created" }],
      missing: [],
      failure: null,
      next: "npx @downtrace/agent check",
    });
    // What check finds and reads, from where it runs: exactly the command init wrote, and nothing it would refuse.
    const found = await findConfig(dir, dir);
    expect(found?.path).toBe(join(dir, "downtrace.json"));
    expect(parseConfig(found?.text ?? "", "downtrace.json")).toEqual({
      ok: true,
      config: { command: "npm run test:integration", prepare: undefined, routes: [], timeoutSeconds: undefined },
    });
  });

  it("runs the script with the package manager the lockfile names, and says npx downtrace once it is installed", async () => {
    const dir = await project({
      ".git/": "",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "package.json": json({
        dependencies: { koa: "^3", ioredis: "^5" },
        devDependencies: { "@downtrace/agent": "^0.9.0" },
        scripts: { test: "node --test" },
      }),
    });
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(report).toMatchObject({ command: "pnpm test", next: "npx downtrace check" });
    expect(report.detected).toMatchObject({ frameworks: ["koa"], observed: ["ioredis"], packageManager: "pnpm" });
  });

  it("says what it found and what it wrote, in words", async () => {
    const dir = await project({ ".git/": "", "package.json": EXPRESS_PG });
    const { code, text } = await initText(dir);
    expect(code).toBe(0);
    expect(text).toContain(`downtrace init: configured ${dir}`);
    expect(text).toMatch(/framework\s+express/);
    expect(text).toMatch(/observed\s+pg, outgoing HTTP/);
    expect(text).toMatch(/check runs\s+npm run test:integration/);
    expect(text).toMatch(/created\s+downtrace\.json/);
    expect(text).toContain("Next: npx @downtrace/agent check");
  });
});

describe("a Next.js build with output: standalone", () => {
  it("writes the instrumentation hook of the README, beside the configuration", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.ts":
        'import type { NextConfig } from "next";\nexport default { output: "standalone" } satisfies NextConfig;\n',
      "tsconfig.json": '{ "compilerOptions": { "moduleResolution": "bundler" } }',
      "app/": "",
    });
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(report.detected?.bundler).toBe("next-standalone");
    expect(report.files).toEqual([
      { path: "downtrace.json", action: "created" },
      { path: "instrumentation.ts", action: "created" },
    ]);
    expect(await readFile(join(dir, "instrumentation.ts"), "utf8")).toBe(INSTRUMENTATION_FILE);
  });

  it("writes it in src/ when the application is there, and in JavaScript for a project with no tsconfig.json", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.mjs": 'export default { output: "standalone" };\n',
      "src/pages/": "",
    });
    const { report } = await init(dir);
    expect(report.files).toContainEqual({ path: "src/instrumentation.js", action: "created" });
    expect(await readFile(join(dir, "src/instrumentation.js"), "utf8")).toBe(INSTRUMENTATION_FILE);
  });

  it("writes no hook that would break the build when the package is not installed, and says how to install it", async () => {
    const pkg = JSON.parse(NEXT_APP()) as { dependencies: Record<string, string> };
    delete pkg.dependencies["@downtrace/agent"];
    const dir = await project({
      ".git/": "",
      "yarn.lock": "",
      "package.json": json(pkg),
      "next.config.js": 'module.exports = { output: "standalone" };\n',
    });
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.status).toBe("incomplete");
    expect(report.missing.map((item) => item.code)).toEqual(["not-installed"]);
    expect(report.missing[0]?.advice).toContain("yarn add @downtrace/agent");
    expect(report.missing[0]?.advice).toContain("npx downtrace init");
    expect(await contents(dir)).not.toHaveProperty("instrumentation.js");
    // What could be written was: check can run, with the package from the registry under its own name.
    expect(report.files).toEqual([{ path: "downtrace.json", action: "created" }]);
    expect(report.next).toBe("npx @downtrace/agent check");
  });

  it("does not touch a hook the project already has, and says what to add to it", async () => {
    const theirs = "export async function register() {\n  await import('./otel');\n}\n";
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.js": 'module.exports = { output: "standalone" };\n',
      "instrumentation.ts": theirs,
      "tsconfig.json": "{}",
    });
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.missing.map((item) => item.code)).toEqual(["instrumentation-exists"]);
    expect(report.missing[0]?.advice).toContain('await import("@downtrace/agent/register")');
    expect(report.missing[0]?.advice).toContain('process.env.NEXT_RUNTIME === "nodejs"');
    expect(await readFile(join(dir, "instrumentation.ts"), "utf8")).toBe(theirs);
  });

  it("leaves a hook that already loads the instrumentation as it is", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.js": 'module.exports = { output: "standalone" };\n',
      "src/instrumentation.ts": 'export async function register() { await import("@downtrace/agent/register"); }\n',
      "src/app/": "",
      "tsconfig.json": "{}",
    });
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(report.files).toContainEqual({ path: "src/instrumentation.ts", action: "unchanged" });
    expect(await contents(dir)).not.toHaveProperty("instrumentation.ts");
  });

  it("writes no hook a tsconfig.json cannot resolve, and says what to set", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.js": 'module.exports = { output: "standalone" };\n',
      "tsconfig.json": '{\n  // from create-next-app 13\n  "compilerOptions": { "moduleResolution": "node" }\n}\n',
    });
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.missing.map((item) => item.code)).toEqual(["module-resolution"]);
    expect(report.missing[0]?.advice).toContain('"bundler"');
    expect(await contents(dir)).not.toHaveProperty("instrumentation.ts");
  });
});

describe("what it cannot detect", () => {
  it("says it found no framework and no test command, what to do instead, writes nothing and ends with 1", async () => {
    const dir = await project({ ".git/": "", "package.json": json({ name: "tool", scripts: { build: "tsc" } }) });
    const before = await contents(dir);
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.status).toBe("incomplete");
    expect(report.missing.map((item) => item.code)).toEqual(["no-framework", "no-test-command"]);
    expect(report.missing[1]?.advice).toContain("walk of the routes");
    expect(report.missing[1]?.advice).toContain("npx @downtrace/agent check -- <command>");
    expect(report).toMatchObject({ command: null, files: [], next: null });
    expect(await contents(dir)).toEqual(before);
  });

  it("says so in words, with every advice", async () => {
    const dir = await project({ ".git/": "", "package.json": "{}" });
    const { code, text } = await initText(dir);
    expect(code).toBe(1);
    expect(text).toContain("not configured yet");
    expect(text).toContain("2 things to do");
    expect(text).toContain("To do:");
    expect(text).toContain("walk of the routes");
    expect(text).not.toContain("Next:");
  });

  it("counts npm's placeholder as no test", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": json({
        dependencies: { express: "5" },
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    });
    const { report } = await init(dir);
    expect(report.missing.map((item) => item.code)).toEqual(["no-test-command"]);
  });

  it("writes the command of a project with no framework it names routes for, and says what check does with it", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": json({ dependencies: { fastify: "5" }, scripts: { test: "tap" } }),
    });
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.missing.map((item) => item.code)).toEqual(["no-framework"]);
    expect(report.missing[0]?.advice).toContain("by the shape of its path");
    expect(report.command).toBe("npm test");
    expect(report.next).toBe("npx @downtrace/agent check");
  });

  it("says check needs a git repository when no repository holds the project", async () => {
    const dir = await project({ "package.json": EXPRESS_PG });
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.missing.map((item) => item.code)).toEqual(["not-a-repository"]);
    expect(report.files).toEqual([{ path: "downtrace.json", action: "created" }]);
  });

  it("says there is no package.json where it runs", async () => {
    const dir = await project({ ".git/": "" });
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report).toMatchObject({ status: "incomplete", detected: null, files: [] });
    expect(report.missing.map((item) => item.code)).toEqual(["no-package-json"]);
    expect(await contents(dir)).toEqual({});
  });

  it("never spells a bare npx downtrace for a project that does not have the package", async () => {
    const dir = await project({ "package.json": json({ scripts: { build: "tsc" } }) });
    const { text } = await initText(dir);
    const { report } = await init(dir);
    expect(report.missing.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/npx downtrace\b/);
    expect(JSON.stringify(report)).not.toMatch(/npx downtrace\b/);
  });
});

describe("files it cannot read", () => {
  it.each([
    ["not JSON", '{ "name": "shop", }'],
    ["dependencies that are a list", '{ "dependencies": ["express"] }'],
  ])("says a package.json that is %s cannot be read, writes nothing and ends with 2", async (_what, text) => {
    const dir = await project({ ".git/": "", "package.json": text });
    const before = await contents(dir);
    const { code, report } = await init(dir);
    expect(code).toBe(2);
    expect(report).toMatchObject({
      status: "failed",
      detected: null,
      files: [],
      failure: { code: "bad-package-json" },
    });
    expect(report.failure?.message).toContain(join(dir, "package.json"));
    expect(await contents(dir)).toEqual(before);
    const words = await initText(dir);
    expect(words.text).toContain("nothing was written");
  });

  it.each([
    ["not JSON", '{"check": {"command": "npm test",}}'],
    ["a key check does not know", '{"check": {"commmand": "npm test"}}'],
    ["a check that is a string", '{"check": "npm test"}'],
  ])("does not rewrite a downtrace.json that is %s, writes nothing at all and ends with 2", async (_what, text) => {
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.js": 'module.exports = { output: "standalone" };\n',
      "downtrace.json": text,
    });
    const before = await contents(dir);
    const { code, report } = await init(dir);
    expect(code).toBe(2);
    expect(report.failure?.code).toBe("bad-config");
    expect(await contents(dir)).toEqual(before);
  });

  it("says a file that cannot be read cannot be, and ends with 2", async () => {
    // A package.json that is a directory: nothing init is prepared for, and everything that is its business to say.
    const dir = await project({ ".git/": "", "package.json/": "" });
    const { code, report } = await init(dir);
    expect(code).toBe(2);
    expect(report.failure?.code).toBe("io-error");
  });
});

describe("run again", () => {
  it("writes nothing twice, ends as it did, and says every file is unchanged", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.js": 'module.exports = { output: "standalone" };\n',
      "tsconfig.json": "{}",
    });
    const first = await init(dir);
    const after = await contents(dir);
    const second = await init(dir);
    expect(second.code).toBe(first.code);
    expect(second.code).toBe(0);
    expect(await contents(dir)).toEqual(after);
    expect(second.report.files).toEqual([
      { path: "downtrace.json", action: "unchanged" },
      { path: "instrumentation.ts", action: "unchanged" },
    ]);
  });

  it("keeps what a person wrote in downtrace.json, byte for byte", async () => {
    const dir = await project({ ".git/": "", "package.json": EXPRESS_PG });
    await init(dir);
    const edited =
      '{\n  "owner": "payments",\n  "check": { "command": "make test-db", "routes": ["GET /orders"], "timeout": 300 }\n}\n';
    await writeFile(join(dir, "downtrace.json"), edited);
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(report.command).toBe("make test-db");
    expect(report.detected?.testCommand).toBe("npm run test:integration");
    expect(report.files).toEqual([{ path: "downtrace.json", action: "unchanged" }]);
    expect(await readFile(join(dir, "downtrace.json"), "utf8")).toBe(edited);
  });

  it("adds the command to a downtrace.json that has none, and keeps every other key where it was", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": EXPRESS_PG,
      "downtrace.json": json({ owner: "payments", check: { routes: ["GET /orders"], timeout: 300 }, extra: [1] }),
    });
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(report.files).toEqual([{ path: "downtrace.json", action: "updated" }]);
    const written = JSON.parse(await readFile(join(dir, "downtrace.json"), "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      owner: "payments",
      check: { command: "npm run test:integration", routes: ["GET /orders"], timeout: 300 },
      extra: [1],
    });
    expect(Object.keys(written)).toEqual(["owner", "check", "extra"]);
    const again = await init(dir);
    expect(again.report.files).toEqual([{ path: "downtrace.json", action: "unchanged" }]);
  });
});

describe("as a user runs it", () => {
  it("makes no network request", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": NEXT_APP(),
      "next.config.js": "module.exports = { output: 'standalone' };",
    });
    const connections = join(dir, "connections.txt");
    await writeFile(connections, "");
    const tripwire = new URL("./support/network-tripwire.mjs", import.meta.url).href;
    const env = cleanEnv({ NODE_OPTIONS: `--import=${tripwire}`, TRIPWIRE_FILE: connections });

    // The tripwire is live in a process started this way: a connection is written down.
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await promisify(execFile)(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}/").then((r) => r.text())`], {
      env,
    });
    await new Promise((resolve) => server.close(resolve));
    expect((await readFile(connections, "utf8")).trim()).toBe(`127.0.0.1:${port}`);
    await writeFile(connections, "");

    const { done } = downtrace(["init", "--json"], { cwd: dir, env });
    const result = await done;
    expect(result.code, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as InitReport).files).toHaveLength(2);
    expect(await readFile(connections, "utf8")).toBe("");
  });

  it("leaves a project that check runs next, with no further step", async () => {
    const made = await createProject({
      "package.json": json({
        name: "shop",
        type: "module",
        dependencies: { express: "^5.2.1", pg: "^8.23.0" },
        scripts: { "test:integration": "node app.mjs" },
      }),
      "app.mjs": APP,
      "regressions.json": "{}",
    });
    projects.push(made);
    const env = cleanEnv({ npm_config_update_notifier: "false" });
    const initialised = await downtrace(["init"], { cwd: made.dir, env }).done;
    expect(initialised.code, initialised.stdout).toBe(0);
    expect(initialised.stdout).toContain("Next: npx @downtrace/agent check");

    const checked = await downtrace(["check", "--json"], { cwd: made.dir, env }).done;
    const report = JSON.parse(checked.stdout) as CheckReport;
    expect(report.status, checked.stderr).toBe("compared");
    expect(report.change?.command).toBe("npm run test:integration");
    expect(report.routes.map((route) => route.id)).toContain("POST /checkout");
  });
});
