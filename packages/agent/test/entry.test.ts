import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applicationEntry, preservesSymlinksMain } from "../src/entry.ts";

/**
 * DT-34. Node runs an application's main module from its realpath, and the instrumentation resolved `pg` and
 * Express from `process.argv[1]`, which is the path the process was started with. Through a symlinked binary —
 * `npm i -g`, `/usr/local/bin/<app>`, n8n's official image — the two are not in the same directory, and from
 * the link's directory nothing resolved: `pg` was `unavailable` and no mount was recorded.
 *
 * The children below are the proof: the question is how a fresh process started through a link resolves, and
 * the test's own process was not started that way. They wait on the child's exit, never on a timer.
 */
const src = (file: string): string => fileURLToPath(new URL(`../src/${file}`, import.meta.url));
const register = src("register.ts");
const index = src("index.ts");

/** The Express this package's tests run against, by its real directory: what an application's `node_modules` holds. */
const EXPRESS = path.dirname(createRequire(import.meta.url).resolve("express/package.json"));

/** A `pg` of the application's own, so the version it reports says which one was resolved. */
const PG = `
  class Client { query() { return Promise.resolve({ rows: [] }); } }
  class Pool {}
  module.exports = { Client, Pool };
`;

interface Installed {
  /** The application's entry, in its real directory, beside a `node_modules` that holds `pg` and `express`. */
  entry: string;
  /** A symlink to the entry in a directory of its own, from which nothing resolves: the binary on the PATH. */
  bin: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** An application installed the way `npm i -g` installs one: the package in a lib, and a link to it in a bin. */
async function installed(server = ""): Promise<Installed> {
  // The realpath of the temporary directory, because on macOS it is itself behind a link (`/var` is
  // `/private/var`), and what is compared below is the path Node arrives at.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "downtrace-entry-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, "lib", "app");
  const modules = path.join(app, "node_modules");
  await mkdir(path.join(modules, "pg"), { recursive: true });
  await writeFile(
    path.join(modules, "pg", "package.json"),
    JSON.stringify({ name: "pg", version: "8.99.0", main: "index.js" }),
  );
  await writeFile(path.join(modules, "pg", "index.js"), PG);
  await symlink(EXPRESS, path.join(modules, "express"));
  const entry = path.join(app, "server.cjs");
  await writeFile(entry, server);
  await mkdir(path.join(dir, "bin"));
  const bin = path.join(dir, "bin", "server");
  await symlink(entry, bin);
  return { entry, bin };
}

/** The environment a child sees: the parent's, minus what would decide the answer for it, plus the scenario's.
 * `NODE_PATH` goes, because the test runner puts the package store on it and an application is never started
 * that way; `NODE_OPTIONS` goes, because it is one of the two places the flag under test is read from. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DOWNTRACE_")) delete env[key];
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  return { ...env, ...extra };
}

function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("applicationEntry", () => {
  it("is the file a symlinked entry points to, which is the one Node runs", async () => {
    const { entry, bin } = await installed();
    expect(applicationEntry({ argv: ["node", bin] })).toBe(entry);
  });

  it("is the link itself when Node keeps the main module's symlinks", async () => {
    const { bin } = await installed();
    expect(applicationEntry({ argv: ["node", bin], preserveSymlinksMain: true })).toBe(bin);
  });

  it("is the path as given when it does not exist, and does not throw", () => {
    const missing = path.join(os.tmpdir(), "downtrace-entry-no-such-directory", "server.js");
    expect(applicationEntry({ argv: ["node", missing] })).toBe(missing);
  });

  it("is the path as given when its realpath cannot be read, and does not throw", async () => {
    // Two links that point at each other: the path exists and the realpath fails (ELOOP). A permission would
    // say the same on a laptop and nothing as root, which is how CI may run.
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "downtrace-entry-loop-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const a = path.join(dir, "a");
    await symlink(path.join(dir, "b"), a);
    await symlink(a, path.join(dir, "b"));
    expect(applicationEntry({ argv: ["node", a] })).toBe(a);
  });

  it("is absolute when the process was given a relative path, which createRequire would refuse", () => {
    expect(applicationEntry({ argv: ["node", "no-such-entry-34.js"] })).toBe(path.resolve("no-such-entry-34.js"));
  });

  it("is the working directory when the process was started without a script", () => {
    expect(applicationEntry({ argv: ["node"] })).toBe(`${process.cwd()}/`);
  });

  it("does not throw when the working directory was removed under the process", async () => {
    // In a child: the working directory is the process's, and the test's own must stay where it is. Node
    // throws ENOENT from `process.cwd()` and from `path.resolve` of a relative path once it is gone.
    const dir = await mkdtemp(path.join(os.tmpdir(), "downtrace-entry-cwd-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const script = `
      import { rmSync } from "node:fs";
      import { applicationEntry } from ${JSON.stringify(src("entry.ts"))};
      process.chdir(${JSON.stringify(dir)});
      rmSync(${JSON.stringify(dir)}, { recursive: true });
      let gone = false;
      try { process.cwd(); } catch { gone = true; }
      console.log(JSON.stringify({ gone, entries: [applicationEntry({ argv: ["node"] }), applicationEntry({ argv: ["node", "server.js"] })] }));
    `;
    const { code, stdout, stderr } = await runNode(["--input-type=module", "-e", script], childEnv());
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ gone: true, entries: ["/", "/"] });
  }, 30_000);
});

/**
 * Each row is a way of starting Node, and the test asks Node itself which way it went: a child started through
 * a link with those flags reports the main module it ran, and the reading has to agree with it. The table is
 * not a belief about Node's parser; it is checked against it on every run.
 */
describe("preservesSymlinksMain agrees with Node", () => {
  const rows: Array<[string, string[], string | undefined]> = [
    ["nothing", [], undefined],
    ["the flag on the command line", ["--preserve-symlinks-main"], undefined],
    ["the flag in NODE_OPTIONS", [], "--preserve-symlinks-main"],
    [
      "the command line turning off what NODE_OPTIONS turned on",
      ["--no-preserve-symlinks-main"],
      "--preserve-symlinks-main",
    ],
    [
      "the command line turning on what NODE_OPTIONS turned off",
      ["--preserve-symlinks-main"],
      "--no-preserve-symlinks-main",
    ],
    ["the last spelling on the command line", ["--preserve-symlinks-main", "--no-preserve-symlinks-main"], undefined],
    ["underscores for dashes", ["--preserve_symlinks_main"], undefined],
    ["underscores in NODE_OPTIONS", [], "--preserve_symlinks_main"],
    ["a value after the flag, which Node does not read", ["--preserve-symlinks-main=false"], undefined],
    ["--preserve-symlinks, which does not apply to the main module", ["--preserve-symlinks"], undefined],
    ["the flag in quotes in NODE_OPTIONS", [], '"--preserve-symlinks-main"'],
    ["the flag inside another option's quoted value", [], '--title="x --preserve-symlinks-main"'],
    ["other options and spaces around it", [], "  --max-old-space-size=512   --preserve-symlinks-main  --no-warnings "],
  ];

  it.each(rows)("%s", async (_what, execArgv, nodeOptions) => {
    const { entry, bin } = await installed("console.log(__filename);");
    const env = childEnv(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions });
    const { code, stdout, stderr } = await runNode([...execArgv, bin], env);
    expect(code, stderr).toBe(0);
    // Node ran one of the two, and said which: a row whose child printed nothing would agree with «no» by default.
    expect([entry, bin]).toContain(stdout.trim());
    const nodeKeptTheLink = stdout.trim() === bin;
    expect(preservesSymlinksMain(execArgv, nodeOptions)).toBe(nodeKeptTheLink);
  });
});

/**
 * The three places that resolve a module from the application's entry, each called with no `from`: what
 * production gives them when nothing hands them a root. The child is started with `-e`, so Node runs no main
 * module and `process.argv[1]` is the link exactly as written — the path a symlinked binary leaves there.
 */
describe("each site resolves from the entry Node resolved, not from the link", () => {
  const SITES = `
    import { createRequire } from "node:module";
    import { armPg, instrumentPg } from ${JSON.stringify(src("instrument/pg.ts"))};
    import { armMounts } from ${JSON.stringify(src("mounts.ts"))};
    const deps = {
      log: { warn: () => {}, debug: () => {} },
      internalError: (err) => { console.error(String(err)); process.exit(2); },
    };
    let fromTheLink = true;
    try { createRequire(process.argv[1]).resolve("pg"); } catch { fromTheLink = false; }
    const instrumented = instrumentPg(deps) ?? null;
    const armed = armPg(deps).state;
    armMounts();
    let mounts = false;
    try {
      const express = createRequire(process.argv[2])("express");
      mounts = express.Router.prototype[Symbol.for("downtrace.mounts.use")] === true;
    } catch {}
    console.log(JSON.stringify({ fromTheLink, instrumentPg: instrumented, armPg: armed, armMounts: mounts }));
  `;

  it("instrumentPg, armPg and armMounts find the application's pg and express through the link", async () => {
    const { entry, bin } = await installed();
    const { code, stdout, stderr } = await runNode(["--input-type=module", "-e", SITES, bin, entry], childEnv());
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(report.fromTheLink, "the failure is real: nothing resolves from the link's directory").toBe(false);
    expect(report.instrumentPg, "instrumentPg patched the application's pg").toBe("8.99.0");
    expect(report.armPg, "armPg resolved the application's pg").toBe("on");
    expect(report.armMounts, "armMounts armed the application's express").toBe(true);
  }, 30_000);

  it("an entry that does not exist leaves each site where it was, and none of them throws", async () => {
    const { entry } = await installed();
    const missing = path.join(path.dirname(entry), "..", "..", "bin", "no-such-server");
    const { code, stdout, stderr } = await runNode(["--input-type=module", "-e", SITES, missing, entry], childEnv());
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      fromTheLink: false,
      instrumentPg: null,
      armPg: "unavailable",
      armMounts: false,
    });
  }, 30_000);
});

/**
 * The application, as a symlinked binary runs it. It serves one request under a mount with a parameter, asks
 * the instrumentation to flush, and says which main module Node ran and whether it could load its own express:
 * the scenario's own account of how Node resolved it, which the assertions check before trusting the rest.
 */
const SERVER = `
const http = require("node:http");
const { pathToFileURL } = require("node:url");
let express;
try {
  express = require("express");
} catch {
  express = undefined;
}
async function main() {
  let server;
  if (express !== undefined) {
    const app = express();
    const users = express.Router();
    users.get("/users/:id", (_req, res) => res.send("ok"));
    app.use("/tenants/:tenant", users);
    server = http.createServer(app);
  } else {
    server = http.createServer((_req, res) => res.end("ok"));
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const res = await fetch("http://127.0.0.1:" + server.address().port + "/tenants/acme/users/7");
  await res.arrayBuffer();
  const { shutdown } = await import(pathToFileURL(process.argv[2]).href);
  await shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify({ main: __filename, express: express !== undefined }));
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

interface Started {
  /** The main module Node ran, and whether the application could load its own express from it. */
  report: { main: string; express: boolean };
  /** What the instrumentation said it watches, from the last batch it would have sent. */
  pg: unknown;
  /** Every route in every batch it would have sent. */
  routes: string[];
}

/** Starts the installed application through its link with the instrumentation loaded, as `--import` does. */
async function start(bin: string, flags: string[], extra: Record<string, string> = {}): Promise<Started> {
  const env = childEnv({ DOWNTRACE_INSPECT: "stderr", ...extra });
  const { code, stdout, stderr } = await runNode([...flags, "--import", register, bin, index], env);
  expect(code, `the child failed\n${stderr}`).toBe(0);
  let pg: unknown;
  const routes: string[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.trimStart().startsWith("{")) continue;
    const batch = JSON.parse(line) as {
      agent?: { observers?: { pg?: unknown } };
      intervals?: { endpoints?: { route?: unknown }[] }[];
    };
    if (batch.agent?.observers !== undefined) pg = batch.agent.observers.pg;
    for (const interval of batch.intervals ?? [])
      for (const endpoint of interval.endpoints ?? [])
        if (typeof endpoint.route === "string") routes.push(endpoint.route);
  }
  return { report: JSON.parse(stdout.trim()) as Started["report"], pg, routes };
}

describe("an application started through a symlinked binary, with the instrumentation loaded", () => {
  it("watches its pg and keeps the pattern of its mounts", async () => {
    const { entry, bin } = await installed(SERVER);
    const started = await start(bin, []);
    expect(started.report, "Node ran the file the link points to, and the application found its express").toEqual({
      main: entry,
      express: true,
    });
    expect(started.pg, "pg resolved from the application's directory").toBe("on");
    expect(started.routes, "the mount's pattern, not :param").toContain("/tenants/:tenant/users/:id");
  }, 30_000);

  it.each([
    ["on the command line", ["--preserve-symlinks-main"], {}],
    ["in NODE_OPTIONS", [], { NODE_OPTIONS: "--preserve-symlinks-main" }],
  ])(
    "with --preserve-symlinks-main %s, resolves from the link, as Node does",
    async (_where, flags, extra) => {
      const { bin } = await installed(SERVER);
      const started = await start(bin, flags, extra);
      expect(started.report, "Node ran the link, and the application could not load express from there").toEqual({
        main: bin,
        express: false,
      });
      expect(started.pg, "pg resolved from where Node resolved the application: nowhere").toBe("unavailable");
    },
    30_000,
  );
});
