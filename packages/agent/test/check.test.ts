import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../src/check/report.ts";
import { appFiles, cleanEnv, createProject, downtrace, type Project, snapshot } from "./support/check-project.ts";
import { rootOf } from "./support/mariadb.ts";
import { type FakeMysql, startFakeMysql } from "./support/mysql.ts";
import { generatePrisma, PRISMA_DIR, PRISMA_QUIET, type PrismaLayout, prismaSchema } from "./support/prisma-client.ts";

/**
 * `downtrace check`, as a user runs it: the real command, in a real git repository, running a real application
 * twice — on the base commit and on the working tree — and saying what changed by composition (LOC-01).
 *
 * Real processes and a real repository, because what these tests are about is what happens around the comparison:
 * a worktree that is made and must be removed, a working tree that must not be touched, a process that must not
 * reach the network, and a run that fails in the ways a project's does.
 */
// covers: LOC-01, ESC-17, ESC-18

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/** The directory of the Express this package is tested against, for a project of a test to depend on. */
const EXPRESS_DIR = dirname(createRequire(import.meta.url).resolve("express/package.json"));
/** Express 4, which most Express backends still run, and `pg`, for a suite Jest runs. */
const EXPRESS4_DIR = dirname(createRequire(import.meta.url).resolve("express4/package.json"));
const PG_DIR = dirname(createRequire(import.meta.url).resolve("pg/package.json"));
/** The same for Fastify. */
const FASTIFY_DIR = dirname(createRequire(import.meta.url).resolve("fastify/package.json"));
/** postgres.js's, whose exports name no `package.json`: three directories above the file `require` resolves. */
const POSTGRESJS_DIR = dirname(dirname(dirname(createRequire(import.meta.url).resolve("postgres"))));
/** MongoDB's driver and Mongoose, and the tests' own MongoDB server, for a project to run against. */
const MONGODB_DIR = dirname(createRequire(import.meta.url).resolve("mongodb/package.json"));
const MONGOOSE_DIR = dirname(createRequire(import.meta.url).resolve("mongoose/package.json"));
const MONGO_WIRE = new URL("./support/mongo-wire.mjs", import.meta.url);
/** SQLite's two drivers: better-sqlite3, and `@libsql/client`, whose exports name no `package.json` either. */
const BETTER_SQLITE3_DIR = dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json"));
const LIBSQL_CLIENT_DIR = dirname(dirname(createRequire(import.meta.url).resolve("@libsql/client")));
/** node-sqlite3, and Knex, which opens SQLite with it and finds the same copy through its peer dependency. */
const SQLITE3_DIR = dirname(createRequire(import.meta.url).resolve("sqlite3/package.json"));
const KNEX_DIR = dirname(createRequire(import.meta.url).resolve("knex/package.json"));
/** Vitest's, for a suite it runs. */
const VITEST_DIR = dirname(createRequire(import.meta.url).resolve("vitest/package.json"));
/** Hono's, the same way: `require` resolves `dist/cjs/index.js`. */
const HONO_DIR = dirname(dirname(dirname(createRequire(import.meta.url).resolve("hono"))));

const projects: Project[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.cleanup();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<Project> {
  const made = await createProject(files);
  projects.push(made);
  return made;
}

/** A directory of the test's own, for what `check` makes (TMPDIR) and for what the test keeps. */
async function room(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-check-room-")));
  scratch.push(dir);
  return dir;
}

interface Checked {
  code: number | null;
  report: CheckReport;
  stdout: string;
  stderr: string;
}

async function check(
  where: Project,
  args: string[],
  env: Record<string, string> = {},
  options: { cwd?: string } = {},
): Promise<Checked> {
  const { done } = downtrace(["check", "--json", ...args], { cwd: options.cwd ?? where.dir, env: cleanEnv(env) });
  const result = await done;
  return { ...result, report: JSON.parse(result.stdout) as CheckReport };
}

/** The worktrees the repository knows of: its own, and any a check left behind. */
async function worktrees(made: Project): Promise<string[]> {
  const listed = await made.git("worktree", "list", "--porcelain");
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** Whether a process is still running: a zombie nobody has reaped yet has stopped, whatever `kill` says. */
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const { stdout } = await promisify(execFile)("ps", ["-o", "stat=", "-p", String(pid)]).catch(() => ({ stdout: "Z" }));
  return !stdout.trim().startsWith("Z") && stdout.trim() !== "";
}

/** The pid a command wrote down once it started, waited for: a shell takes a moment to get as far as writing it. */
async function pidIn(file: string): Promise<number> {
  for (let tries = 0; tries < 100; tries += 1) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${file} was never written`);
}

const route = (report: CheckReport, id: string) => {
  const found = report.routes.find((one) => one.id === id);
  if (found === undefined) throw new Error(`the report has no ${id}: ${report.routes.map((one) => one.id).join(", ")}`);
  return found;
};

const REGRESSION = { perLine: true, newHost: true };

describe("a change that makes a route run more than it did (ESC-17)", () => {
  let checked: Checked;
  beforeAll(async () => {
    const regress = await createProject(appFiles({}));
    projects.push(regress);
    // The change is not committed: the working tree is what is compared with the base.
    await regress.write("regressions.json", JSON.stringify({ ...REGRESSION, reports: true }));
    checked = await check(regress, ["--base", "HEAD"]);
  });

  it("names the route as worse, and exits 1 for CI", () => {
    expect(checked.report.status).toBe("compared");
    expect(route(checked.report, "POST /checkout").verdict).toBe("worse");
    expect(checked.code).toBe(1);
  });

  it("names what appeared by its fingerprint and how many times a request ran it", () => {
    const appeared = route(checked.report, "POST /checkout").operations.find(
      (operation) => operation.change === "appeared",
    );
    expect(appeared).toMatchObject({
      kind: "call",
      label: "GET localhost (any port)",
      perRequest: { base: 0, change: 1 },
      executions: { base: 0, change: 3 },
      worse: true,
    });
  });

  it("says by how much an operation that was already there is repeated", () => {
    const multiplied = route(checked.report, "POST /checkout").operations.find(
      (operation) => operation.change === "multiplied",
    );
    expect(multiplied).toMatchObject({ kind: "call", perRequest: { base: 1, change: 12 } });
  });

  it("says how many requests each side saw of the route", () => {
    expect(route(checked.report, "POST /checkout")).toMatchObject({
      requests: { base: 3, change: 3 },
      profiledRequests: { base: 3, change: 3 },
    });
  });

  it("leaves what did not change as unchanged: the same code on a route beside it", () => {
    expect(route(checked.report, "GET /products").verdict).toBe("unchanged");
  });

  it("shows the durations of the two runs and judges neither", () => {
    const checkout = route(checked.report, "POST /checkout");
    expect(checkout.meanRequestMs.base).toBeGreaterThan(0);
    expect(checkout.meanRequestMs.change).toBeGreaterThan(0);
    expect(checked.report.notes.join("\n")).toContain("never judged");
  });

  it("keeps the progress of a run that takes minutes on stderr, so that stdout is the result alone", () => {
    expect(checked.stderr).toContain("downtrace: base: running node app.mjs");
    expect(() => JSON.parse(checked.stdout)).not.toThrow();
  });
});

describe("routes the tests do not exercise (ESC-18)", () => {
  let checked: Checked;
  beforeAll(async () => {
    const made = await createProject(appFiles({}));
    projects.push(made);
    await made.write("regressions.json", JSON.stringify({ reports: true }));
    checked = await check(made, ["--base", "HEAD"]);
  });

  it("lists a declared route nobody called, by name, as not evaluated", () => {
    expect(route(checked.report, "GET /orders")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "not-called" }],
    });
  });

  it("lists a route that only one run reached, and says which", () => {
    expect(route(checked.report, "GET /reports")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "not-called-in-base" }],
    });
  });

  it("lists a route whose requests ran nothing observable, which is what a simulated database looks like", () => {
    expect(route(checked.report, "GET /health")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "nothing-observed" }],
    });
  });

  it("offers no link to tell Downtrace: a route with no dependencies, in a project whose drivers it observes, is one", () => {
    expect(checked.report.feedback).toBeNull();
  });

  it("never lists as unchanged a route it did not evaluate", () => {
    const unchanged = checked.report.routes.filter((one) => one.verdict === "unchanged").map((one) => one.id);
    expect(unchanged).toContain("GET /products");
    for (const id of ["GET /orders", "GET /reports", "GET /health"]) expect(unchanged).not.toContain(id);
    expect(checked.report.summary?.notEvaluated).toBeGreaterThanOrEqual(3);
  });
});

describe("routes an Express application declares and no test calls, with no list written by hand (ESC-18)", () => {
  // What `init` leaves: a test command and nothing else. The application says which routes it has.
  const EXPRESS_APP = `
import http from "node:http";
import express from "express";

const provider = http.createServer((req, res) => {
  req.resume();
  res.end("ok");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = provider.address().port;
const agent = new http.Agent({ keepAlive: false });
const call = () =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: providerPort, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });

const app = express();
app.get("/products", async (_req, res) => {
  await call();
  res.send("products");
});
app.get("/orders/:id", (_req, res) => res.send("order"));
const admin = express.Router();
admin.post("/refunds", (_req, res) => res.send("refund"));
app.use("/admin", admin);

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`http://127.0.0.1:\${server.address().port}/products\`);
  await res.text();
}
server.close();
provider.close();
`;
  let checked: Checked;
  beforeAll(async () => {
    const made = await createProject({
      "app.mjs": EXPRESS_APP,
      ".gitignore": "node_modules\n",
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs" } }),
    });
    projects.push(made);
    // The project's own express, as an install leaves it: the one this package is tested against.
    await mkdir(join(made.dir, "node_modules"), { recursive: true });
    await symlink(EXPRESS_DIR, join(made.dir, "node_modules", "express"), "dir");
    checked = await check(made, ["--base", "HEAD"]);
  });

  it("names each route nobody called as not called, mounts included, by the template a request would get", () => {
    for (const id of ["GET /orders/:id", "POST /admin/refunds"]) {
      expect(route(checked.report, id)).toMatchObject({ verdict: "not-evaluated", reasons: [{ code: "not-called" }] });
    }
  });

  it("still evaluates the route the tests called, and counts the others in the summary", () => {
    expect(route(checked.report, "GET /products").verdict).toBe("unchanged");
    // `GET /` is the provider the run starts: a server with no framework is named by its path, and it ran nothing.
    expect(checked.report.routes.map((one) => `${one.verdict} ${one.id}`).sort()).toEqual([
      "not-evaluated GET /",
      "not-evaluated GET /orders/:id",
      "not-evaluated POST /admin/refunds",
      "unchanged GET /products",
    ]);
    expect(checked.report.summary).toMatchObject({ worse: 0, unchanged: 1, notEvaluated: 3 });
    expect(checked.code).toBe(0);
  });
});

describe("routes a Fastify application declares and no test calls (ESC-18)", () => {
  const FASTIFY_APP = `
import Fastify from "fastify";

const app = Fastify();
app.get("/products/:id", async () => {
  const res = await fetch(\`http://127.0.0.1:\${app.server.address().port}/stock\`);
  return res.text();
});
app.get("/stock", async () => "12");
await app.register(
  async (admin) => {
    admin.post("/refunds", async () => "refund");
  },
  { prefix: "/admin" },
);
await app.listen({ port: 0, host: "127.0.0.1" });
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`http://127.0.0.1:\${app.server.address().port}/products/\${i + 1}\`);
  await res.text();
}
await app.close();
`;
  let checked: Checked;
  beforeAll(async () => {
    const made = await createProject({
      "app.mjs": FASTIFY_APP,
      ".gitignore": "node_modules\n",
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs" } }),
    });
    projects.push(made);
    await mkdir(join(made.dir, "node_modules"), { recursive: true });
    await symlink(FASTIFY_DIR, join(made.dir, "node_modules", "fastify"), "dir");
    checked = await check(made, ["--base", "HEAD"]);
  });

  it("names the route nobody called by its template, prefix included, and evaluates the one the run called", () => {
    expect(route(checked.report, "POST /admin/refunds")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "not-called" }],
    });
    expect(route(checked.report, "GET /products/:id").verdict).toBe("unchanged");
    expect(checked.report.routes.map((one) => one.id).sort()).toEqual([
      "GET /products/:id",
      "GET /stock",
      "POST /admin/refunds",
    ]);
    expect(checked.code).toBe(0);
  });
});

describe("a Fastify suite that calls the application with inject(), as Fastify's testing guide does", () => {
  // No server listens: light-my-request hands Fastify a request of its own, and Node announces nothing.
  const INJECTED_APP = `
import http from "node:http";
import { readFileSync } from "node:fs";
import Fastify from "fastify";

const calls = Number(readFileSync(new URL("./calls.txt", import.meta.url), "utf8"));
const provider = http.createServer((req, res) => {
  req.resume();
  res.end("ok");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const stock = \`http://127.0.0.1:\${provider.address().port}/stock\`;

const app = Fastify();
app.get("/products/:id", async () => {
  for (let i = 0; i < calls; i += 1) await (await fetch(stock)).text();
  return "product";
});
app.post("/admin/refunds", async () => "refund");
await app.ready();
for (let i = 0; i < 3; i += 1) {
  const res = await app.inject({ method: "GET", url: \`/products/\${i + 1}\` });
  if (res.statusCode !== 200) throw new Error(\`status \${res.statusCode}\`);
}
await app.close();
provider.close();
`;
  let checked: Checked;
  beforeAll(async () => {
    const made = await createProject({
      "app.mjs": INJECTED_APP,
      "calls.txt": "1",
      ".gitignore": "node_modules\n",
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs" } }),
    });
    projects.push(made);
    await mkdir(join(made.dir, "node_modules"), { recursive: true });
    await symlink(FASTIFY_DIR, join(made.dir, "node_modules", "fastify"), "dir");
    // The change: the route now calls its provider once per item, five times a request.
    await made.write("calls.txt", "5");
    checked = await check(made, ["--base", "HEAD"]);
  });

  it("sees the regression in the injected requests, and exits 1", () => {
    const products = route(checked.report, "GET /products/:id");
    expect(products.verdict).toBe("worse");
    expect(products.requests).toEqual({ base: 3, change: 3 });
    expect(products.operations.find((operation) => operation.kind === "call")).toMatchObject({
      change: "multiplied",
      perRequest: { base: 1, change: 5 },
    });
    expect(checked.code).toBe(1);
  });

  it("names the route no injected request reached as not called", () => {
    expect(route(checked.report, "POST /admin/refunds")).toMatchObject({
      verdict: "not-evaluated",
      reasons: [{ code: "not-called" }],
    });
  });
});

/**
 * Hono's testing guide calls an application with `app.request()`, which hands Hono a `Request`: no server listens, and
 * Node announces nothing. The application is built as most are — a sub-application under a prefix, and a middleware of
 * the application's own — and declares a route no test calls.
 */
const HONO_APP = `
import { Hono } from "hono";

export function makeApp({ calls, stock }) {
  const products = new Hono();
  products.get("/:id", async (c) => {
    for (let i = 0; i < calls; i += 1) await (await fetch(stock)).text();
    return c.text("product");
  });
  const app = new Hono();
  app.use(async (_c, next) => {
    await next();
  });
  app.route("/products", products);
  app.post("/admin/refunds", (c) => c.text("refund"));
  return app;
}
`;

const HONO_SUITE = `
import http from "node:http";
import { readFileSync } from "node:fs";
import { makeApp } from "./app.mjs";

const provider = http.createServer((req, res) => {
  req.resume();
  res.end("ok");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const calls = Number(readFileSync(new URL("./calls.txt", import.meta.url), "utf8"));
const app = makeApp({ calls, stock: \`http://127.0.0.1:\${provider.address().port}/stock\` });
for (let i = 0; i < 3; i += 1) {
  const res = await app.request(\`/products/\${i + 1}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
provider.close();
`;

/** Judges the same Hono application, run by `command` over `files`; the change calls its provider five times a request. */
async function honoProject(files: Record<string, string>, command: string, link: Record<string, string>) {
  const made = await createProject({
    ...files,
    "calls.txt": "1",
    ".gitignore": "node_modules\n",
    "downtrace.json": JSON.stringify({ check: { command } }),
  });
  projects.push(made);
  await mkdir(join(made.dir, "node_modules"), { recursive: true });
  for (const [name, dir] of Object.entries({ hono: HONO_DIR, ...link }))
    await symlink(dir, join(made.dir, "node_modules", name), "dir");
  await made.write("calls.txt", "5");
  return check(made, ["--base", "HEAD"]);
}

function expectHonoJudged(checked: Checked): void {
  const products = route(checked.report, "GET /products/:id");
  expect(products.verdict, JSON.stringify(checked.report.routes.map((r) => r.id))).toBe("worse");
  expect(products.requests).toEqual({ base: 3, change: 3 });
  expect(products.operations.find((operation) => operation.kind === "call")).toMatchObject({
    change: "multiplied",
    perRequest: { base: 1, change: 5 },
  });
  expect(route(checked.report, "POST /admin/refunds")).toMatchObject({
    verdict: "not-evaluated",
    reasons: [{ code: "not-called" }],
  });
  expect(checked.code).toBe(1);
}

describe("a Hono suite that calls the application with app.request(), as Hono's testing guide does", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await honoProject({ "app.mjs": HONO_APP, "suite.mjs": HONO_SUITE }, "node suite.mjs", {});
  });

  it("sees the regression in requests no server received, names the route nobody called, and exits 1", () => {
    expectHonoJudged(checked);
  });
});

describe("a Hono suite Jest runs, on the CommonJS copy Jest hands the tests", () => {
  // The same application and suite, as CommonJS: Jest requires Hono's \`dist/cjs\` into a registry of its own.
  const app = HONO_APP.replace('import { Hono } from "hono";', 'const { Hono } = require("hono");').replace(
    "export function makeApp",
    "module.exports = function makeApp",
  );
  const suite = `
const http = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const makeApp = require("./app.js");

let provider;
beforeAll(async () => {
  provider = http.createServer((req, res) => {
    req.resume();
    res.end("ok");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
});
afterAll(() => new Promise((resolve) => provider.close(resolve)));

test("products", async () => {
  const calls = Number(readFileSync(join(__dirname, "calls.txt"), "utf8"));
  const app = makeApp({ calls, stock: "http://127.0.0.1:" + provider.address().port + "/stock" });
  for (const id of [1, 2, 3]) expect((await app.request("/products/" + id)).status).toBe(200);
});
`;
  let checked: Checked;
  beforeAll(async () => {
    checked = await honoProject(
      {
        "app.js": app,
        "products.test.js": suite,
        "package.json": JSON.stringify({ name: "hono-jest", private: true, jest: { transform: {} } }),
      },
      "node node_modules/jest/bin/jest.js --runInBand",
      { jest: JESTS[0][1] },
    );
  });

  it("sees the regression, and names the route nobody called", () => {
    expectHonoJudged(checked);
  });
});

/**
 * MongoDB, the database of most Express boilerplates, through its driver and through Mongoose (ADR 0237), against the
 * tests' own server: a route that looks its user up once per request in the base, and once per item in the change.
 */
const MONGO_APP = `
import { readFileSync } from "node:fs";
import express from "express";
import { MongoClient } from "mongodb";
import { startMongoWire } from "./mongo-wire.mjs";

const lookups = Number(readFileSync(new URL("./lookups.txt", import.meta.url), "utf8"));
const wire = await startMongoWire();
const client = new MongoClient(wire.url, { serverSelectionTimeoutMS: 2000 });
await client.connect();
const users = client.db().collection("users");
const app = express();
app.get("/users/:id", async (req, res) => {
  for (let i = 0; i < lookups; i += 1) await users.findOne({ id: req.params.id });
  res.send("user");
});
app.post("/users", (req, res) => res.send("made"));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = \`http://127.0.0.1:\${server.address().port}\`;
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`\${base}/users/\${i + 1}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
server.close();
await client.close();
await wire.close();
`;

/** The same, as a Mongoose boilerplate is tested: Jest, in band, supertest's way of calling the application. */
const MONGOOSE_SUITE = `
const http = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const express = require("express");
const mongoose = require("mongoose");

const User = mongoose.model("User", new mongoose.Schema({ email: String }));
let wire;
beforeAll(async () => {
  wire = await (await import("./mongo-wire.mjs")).startMongoWire();
  await mongoose.connect(wire.url, { serverSelectionTimeoutMS: 2000 });
});
afterAll(async () => {
  await mongoose.disconnect();
  await wire.close();
});

function get(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

test("users", async () => {
  const lookups = Number(readFileSync(join(__dirname, "lookups.txt"), "utf8"));
  const app = express();
  app.get("/users/:id", async (req, res) => {
    for (let i = 0; i < lookups; i += 1) await User.findOne({ email: req.params.id }).lean();
    res.send("user");
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  for (const id of [1, 2, 3]) expect(await get(server, "/users/" + id)).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});
`;

async function mongoProject(files: Record<string, string>, command: string, link: Record<string, string>) {
  const made = await createProject({
    ...files,
    "mongo-wire.mjs": await readFile(MONGO_WIRE, "utf8"),
    "lookups.txt": "1",
    ".gitignore": "node_modules\n",
    "downtrace.json": JSON.stringify({ check: { command } }),
  });
  projects.push(made);
  await mkdir(join(made.dir, "node_modules"), { recursive: true });
  for (const [name, dir] of Object.entries({ mongodb: MONGODB_DIR, ...link }))
    await symlink(dir, join(made.dir, "node_modules", name), "dir");
  // The change: the route now looks its user up once per item, four times a request.
  await made.write("lookups.txt", "4");
  return check(made, ["--base", "HEAD"]);
}

function expectLookupsMultiplied(checked: Checked): void {
  const users = route(checked.report, "GET /users/:id");
  expect(users.verdict, JSON.stringify(checked.report.routes.map((r) => [r.id, r.verdict]))).toBe("worse");
  expect(users.requests).toEqual({ base: 3, change: 3 });
  expect(users.operations.find((operation) => operation.kind === "query")).toMatchObject({
    change: "multiplied",
    perRequest: { base: 1, change: 4 },
  });
  expect(checked.code).toBe(1);
}

describe("a suite whose application keeps its data in MongoDB, through the official driver", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await mongoProject({ "app.mjs": MONGO_APP }, "node app.mjs", { express: EXPRESS_DIR });
  });

  it("sees the lookups multiplied, and exits 1", () => {
    expectLookupsMultiplied(checked);
  });
});

describe("a Mongoose suite Jest runs, as a Mongoose boilerplate is tested", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await mongoProject(
      {
        "users.test.js": MONGOOSE_SUITE,
        "package.json": JSON.stringify({ name: "mongoose-jest", private: true, jest: { transform: {} } }),
      },
      "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand",
      { jest: JESTS[0][1], express: EXPRESS4_DIR, mongoose: MONGOOSE_DIR },
    );
  });

  it("sees the lookups the tests' own copy of the driver sent, multiplied", () => {
    expectLookupsMultiplied(checked);
  });
});

/**
 * Prisma before 7, through its engine (ADR 0241): a client generated into `node_modules`, as every Prisma 4 and 5
 * project has it, in an application Node runs; and one generated into the project, as Prisma 6 asks, under Jest, whose
 * base generates its own in `prepare` with the working tree's dependencies linked — the generated directory is what
 * git ignores. The database is a SQLite file both runs use, seeded by each.
 */
/** The application, importing its client from where it was generated. */
const prismaApp = (client: string): string => `
import { readFileSync } from "node:fs";
import express from "express";
import prismaClient from "${client}";

const { PrismaClient } = prismaClient;
const lookups = Number(readFileSync(new URL("./lookups.txt", import.meta.url), "utf8"));
const prisma = new PrismaClient();
await prisma.post.deleteMany();
await prisma.user.deleteMany();
const ana = await prisma.user.create({ data: { email: "ana@example.com", posts: { create: [{ title: "hello" }] } } });
const app = express();
app.get("/users/:id", async (req, res) => {
  for (let i = 0; i < lookups; i += 1) await prisma.post.findMany({ where: { authorId: ana.id } });
  res.send("user");
});
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = \`http://127.0.0.1:\${server.address().port}\`;
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`\${base}/users/\${i + 1}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
server.close();
await prisma.$disconnect();
`;

const PRISMA_SUITE = `
const http = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const express = require("express");
const { PrismaClient } = require("./generated/prisma");

const prisma = new PrismaClient();
let ana;
beforeAll(async () => {
  await prisma.post.deleteMany();
  await prisma.user.deleteMany();
  ana = await prisma.user.create({ data: { email: "ana@example.com", posts: { create: [{ title: "hello" }] } } });
});
afterAll(() => prisma.$disconnect());

function get(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

test("users", async () => {
  const lookups = Number(readFileSync(join(__dirname, "lookups.txt"), "utf8"));
  const app = express();
  app.get("/users/:id", async (req, res) => {
    for (let i = 0; i < lookups; i += 1) await prisma.post.findMany({ where: { authorId: ana.id } });
    res.send("user");
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  for (const id of [1, 2, 3]) expect(await get(server, "/users/" + id)).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});
`;

async function prismaProject(
  layout: PrismaLayout,
  files: Record<string, string>,
  config: Record<string, unknown>,
  link: Record<string, string>,
): Promise<Checked> {
  const database = join(await room(), "app.db");
  const made = await project({
    ...files,
    "lookups.txt": "1",
    "prisma/schema.prisma": prismaSchema(layout, database),
    ".gitignore": "node_modules\ngenerated\n",
    "downtrace.json": JSON.stringify({ check: config }),
  });
  await mkdir(join(made.dir, "node_modules"), { recursive: true });
  for (const [name, dir] of Object.entries(link)) await symlink(dir, join(made.dir, "node_modules", name), "dir");
  await generatePrisma(made.dir, layout, database);
  // The change: the route now looks its user's posts up once per item, four times a request.
  await made.write("lookups.txt", "4");
  return check(made, ["--base", "HEAD"], PRISMA_QUIET);
}

describe("an application whose data goes through Prisma's engine, with its client in node_modules", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await prismaProject(
      "default",
      { "app.mjs": prismaApp("@prisma/client") },
      { command: "node app.mjs" },
      { express: EXPRESS_DIR },
    );
  });

  it("sees the lookups multiplied, under the dependency the datasource is, and exits 1", () => {
    expectLookupsMultiplied(checked);
    const users = route(checked.report, "GET /users/:id");
    expect(users.operations[0]).toMatchObject({ label: "findMany Post", kind: "query" });
    expect(users.dependencies).toEqual([expect.objectContaining({ kind: "query", worse: true })]);
  });

  it("says the prisma observer was on, on both sides", () => {
    expect(checked.report.base?.observers.prisma).toBe("on");
    expect(checked.report.change?.observers.prisma).toBe("on");
  });
});

describe("an application Node runs, whose Prisma client is generated into the project with a runtime of its own", () => {
  // Prisma 6 copies its runtime beside a client generated into the project, and the client requires that copy.
  let checked: Checked;
  beforeAll(async () => {
    checked = await prismaProject(
      "output",
      { "app.mjs": prismaApp("./generated/prisma/index.js") },
      {
        command: "node app.mjs",
        prepare: "node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma",
        link: true,
      },
      { express: EXPRESS_DIR, prisma: PRISMA_DIR },
    );
  });

  it("sees the lookups multiplied, and exits 1", () => {
    expect(checked.report.failure, JSON.stringify(checked.report.failure)).toBeNull();
    expectLookupsMultiplied(checked);
  });
});

const PRISMA_VITEST_SUITE = `
import http from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { afterAll, beforeAll, expect, test } from "vitest";
import prismaClient from "./generated/prisma/index.js";

const { PrismaClient } = prismaClient;
const prisma = new PrismaClient();
let ana;
beforeAll(async () => {
  await prisma.post.deleteMany();
  await prisma.user.deleteMany();
  ana = await prisma.user.create({ data: { email: "ana@example.com", posts: { create: [{ title: "hello" }] } } });
});
afterAll(() => prisma.$disconnect());

function get(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

test("users", async () => {
  const lookups = Number(readFileSync(new URL("./lookups.txt", import.meta.url), "utf8"));
  const app = express();
  app.get("/users/:id", async (req, res) => {
    for (let i = 0; i < lookups; i += 1) await prisma.post.findMany({ where: { authorId: ana.id } });
    res.send("user");
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  for (const id of [1, 2, 3]) expect(await get(server, "/users/" + id)).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});
`;

describe("a suite Vitest runs, whose Prisma client is generated into the project, which Vitest loads itself", () => {
  // Vitest runs a module of the project's directory itself, so the client never enters Node's module cache; only the
  // runtime beside it does, which `check` wraps as it loads (ADR 0243).
  let checked: Checked;
  beforeAll(async () => {
    checked = await prismaProject(
      "output",
      {
        "users.test.mjs": PRISMA_VITEST_SUITE,
        "package.json": JSON.stringify({ name: "prisma-vitest", private: true }),
      },
      {
        command: "node node_modules/vitest/vitest.mjs run",
        prepare: "node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma",
        link: true,
      },
      { vitest: VITEST_DIR, express: EXPRESS_DIR, prisma: PRISMA_DIR },
    );
  });

  it("sees the lookups multiplied, and exits 1", () => {
    expect(checked.report.failure, JSON.stringify(checked.report.failure)).toBeNull();
    expectLookupsMultiplied(checked);
  });
});

describe("a suite Jest runs, whose Prisma client is generated into the project and by the base's prepare", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await prismaProject(
      "output",
      {
        "users.test.js": PRISMA_SUITE,
        "package.json": JSON.stringify({ name: "prisma-jest", private: true, jest: { transform: {} } }),
      },
      {
        command: "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand",
        prepare: "node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma",
        link: true,
      },
      { jest: JESTS[0][1], express: EXPRESS4_DIR, prisma: PRISMA_DIR },
    );
  });

  it("sees the lookups the tests' own copy of the client ran, multiplied", () => {
    expect(checked.report.failure, JSON.stringify(checked.report.failure)).toBeNull();
    expectLookupsMultiplied(checked);
  });
});

/**
 * SQLite in the process (ADR 0239): better-sqlite3 with its statement prepared once at start-up, as its users write it,
 * and `@libsql/client` on a file under Jest, as Drizzle's starters are tested. Nothing to start: the database is a file.
 */
const BETTER_SQLITE3_APP = `
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import express from "express";

const lookups = Number(readFileSync(new URL("./lookups.txt", import.meta.url), "utf8"));
const db = new Database(":memory:");
db.exec('create table "users" ("id" integer primary key, "email" text)');
db.prepare('insert into "users" ("email") values (?)').run("ana@example.com");
const byId = db.prepare('select * from "users" where "id" = ?');
const app = express();
app.get("/users/:id", (req, res) => {
  for (let i = 0; i < lookups; i += 1) byId.get(Number(req.params.id));
  res.send("user");
});
app.post("/users", (req, res) => res.send("made"));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = \`http://127.0.0.1:\${server.address().port}\`;
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`\${base}/users/\${i + 1}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
server.close();
db.close();
`;

const LIBSQL_SUITE = `
const http = require("node:http");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const express = require("express");
const { createClient } = require("@libsql/client");

const client = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "libsql-")), "app.db") });
beforeAll(async () => {
  await client.execute('create table "users" ("id" integer primary key, "email" text)');
  await client.execute({ sql: 'insert into "users" ("email") values (?)', args: ["ana@example.com"] });
});
afterAll(() => client.close());

function get(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

test("users", async () => {
  const lookups = Number(readFileSync(join(__dirname, "lookups.txt"), "utf8"));
  const app = express();
  app.get("/users/:id", async (req, res) => {
    for (let i = 0; i < lookups; i += 1) {
      await client.execute({ sql: 'select * from "users" where "id" = ?', args: [Number(req.params.id)] });
    }
    res.send("user");
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  for (const id of [1, 2, 3]) expect(await get(server, "/users/" + id)).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});
`;

const KNEX_APP = `
import { readFileSync } from "node:fs";
import express from "express";
import knexFactory from "knex";

const lookups = Number(readFileSync(new URL("./lookups.txt", import.meta.url), "utf8"));
const knex = knexFactory({ client: "sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
await knex.schema.createTable("users", (table) => {
  table.increments("id");
  table.string("email");
});
await knex("users").insert({ email: "ana@example.com" });
const app = express();
app.get("/users/:id", async (req, res) => {
  for (let i = 0; i < lookups; i += 1) await knex("users").where({ id: Number(req.params.id) }).first();
  res.send("user");
});
app.post("/users", (req, res) => res.send("made"));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = \`http://127.0.0.1:\${server.address().port}\`;
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`\${base}/users/\${i + 1}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
server.close();
await knex.destroy();
`;

async function sqliteProject(files: Record<string, string>, command: string, link: Record<string, string>) {
  const made = await createProject({
    ...files,
    "lookups.txt": "1",
    ".gitignore": "node_modules\n",
    "downtrace.json": JSON.stringify({ check: { command } }),
  });
  projects.push(made);
  await mkdir(join(made.dir, "node_modules", "@libsql"), { recursive: true });
  for (const [name, dir] of Object.entries(link)) await symlink(dir, join(made.dir, "node_modules", name), "dir");
  // The change: the route now looks its user up once per item, four times a request.
  await made.write("lookups.txt", "4");
  return check(made, ["--base", "HEAD"]);
}

describe("a suite whose application keeps its data in SQLite, through better-sqlite3", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await sqliteProject({ "app.mjs": BETTER_SQLITE3_APP }, "node app.mjs", {
      express: EXPRESS_DIR,
      "better-sqlite3": BETTER_SQLITE3_DIR,
    });
  });

  it("sees the lookups of a statement prepared at start-up multiplied, and exits 1", () => {
    expectLookupsMultiplied(checked);
  });

  it("says the sqlite observer was on, on both sides", () => {
    expect(checked.report.base?.observers.sqlite).toBe("on");
    expect(checked.report.change?.observers.sqlite).toBe("on");
  });
});

/**
 * A runner installed where nothing of the project resolves. pnpm's global virtual store keeps every package outside
 * the project, the runner included; a workspace with `hoist: false` keeps the runner in the root's store and the
 * package's drivers in the package's own `node_modules`. The process's main module is the runner, and the drivers
 * resolved from it are none. Found in Ghost (pnpm 12, `enableGlobalVirtualStore`): its `mysql2` loaded in a process
 * whose mysql observer had found nothing to arm. The runner here is a script in a directory of its own that imports
 * the application from where the command runs; and `NODE_PATH`, which pnpm fills with its store for this suite, is
 * empty, as it is for an application.
 */
const RUNNER = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";
await import(pathToFileURL(join(process.cwd(), process.argv[2])).href);
`;

/** The application, its users under a router mounted at \`/users\`: the template is the mount's and the route's. */
const MOUNTED_APP = BETTER_SQLITE3_APP.replace(
  'app.get("/users/:id", (req, res) => {',
  'const users = express.Router();\napp.use("/users", users);\nusers.get("/:id", (req, res) => {',
);

describe("a suite whose runner is installed outside the project", () => {
  let checked: Checked;
  beforeAll(async () => {
    const elsewhere = await room();
    await writeFile(join(elsewhere, "runner.mjs"), RUNNER);
    const made = await project({
      "app.mjs": MOUNTED_APP,
      "lookups.txt": "1",
      ".gitignore": "node_modules\n",
      "downtrace.json": JSON.stringify({ check: { command: `node ${join(elsewhere, "runner.mjs")} app.mjs` } }),
    });
    await mkdir(join(made.dir, "node_modules"), { recursive: true });
    await symlink(EXPRESS_DIR, join(made.dir, "node_modules", "express"), "dir");
    await symlink(BETTER_SQLITE3_DIR, join(made.dir, "node_modules", "better-sqlite3"), "dir");
    await made.write("lookups.txt", "4");
    checked = await check(made, ["--base", "HEAD"], { NODE_PATH: "" });
  });

  it("resolves the drivers and the mounts from the project, on both sides, and sees the lookups multiplied", () => {
    expect(checked.report.base?.observers.sqlite).toBe("on");
    expect(checked.report.change?.observers.sqlite).toBe("on");
    // The users' template is the mount's and the route's: without the project's express, `GET /:param/:id`.
    expectLookupsMultiplied(checked);
  });
});

describe("a Hono suite whose runner is installed outside the project", () => {
  let checked: Checked;
  beforeAll(async () => {
    const elsewhere = await room();
    await writeFile(join(elsewhere, "runner.mjs"), RUNNER);
    const made = await project({
      "app.mjs": HONO_APP,
      "suite.mjs": HONO_SUITE,
      "calls.txt": "1",
      ".gitignore": "node_modules\n",
      "downtrace.json": JSON.stringify({ check: { command: `node ${join(elsewhere, "runner.mjs")} suite.mjs` } }),
    });
    await mkdir(join(made.dir, "node_modules"), { recursive: true });
    await symlink(HONO_DIR, join(made.dir, "node_modules", "hono"), "dir");
    await made.write("calls.txt", "5");
    checked = await check(made, ["--base", "HEAD"], { NODE_PATH: "" });
  });

  it("wraps the project's Hono routers before their first match, and names the routes", () => {
    expectHonoJudged(checked);
  });
});

describe("an application whose data goes through Knex on sqlite3, the callback driver", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await sqliteProject({ "app.mjs": KNEX_APP }, "node app.mjs", {
      express: EXPRESS_DIR,
      knex: KNEX_DIR,
      sqlite3: SQLITE3_DIR,
    });
  });

  it("sees the lookups multiplied, in the SQL Knex wrote, and exits 1", () => {
    expectLookupsMultiplied(checked);
    expect(route(checked.report, "GET /users/:id").operations[0]?.label).toBe(
      "select * from `users` where `id` = ? limit ?",
    );
    expect(checked.report.base?.observers.sqlite).toBe("on");
  });
});

describe("a suite Jest runs, whose application keeps its data in a file through @libsql/client", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await sqliteProject(
      {
        "users.test.js": LIBSQL_SUITE,
        "package.json": JSON.stringify({ name: "libsql-jest", private: true, jest: { transform: {} } }),
      },
      "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand",
      { jest: JESTS[0][1], express: EXPRESS4_DIR, "@libsql/client": LIBSQL_CLIENT_DIR },
    );
  });

  it("sees the lookups the tests' own copy of libsql ran, multiplied", () => {
    expectLookupsMultiplied(checked);
  });
});

/**
 * MySQL through `mariadb`, the driver Prisma's adapter for MySQL and MariaDB queries through: 3.5, whose modules are
 * ESM, imported as an application in ESM imports it (as myfin-api does, with Prisma 7.10); and 3.4, whose modules are
 * CommonJS, in a suite Jest runs, from Jest's own registry. The server is the one of `support/mysql.ts`, in this
 * process, and the application finds it by `MARIADB_PORT`.
 */
const MARIADB_APP = `
import { readFileSync } from "node:fs";
import express from "express";
import mariadb from "mariadb";

const lookups = Number(readFileSync(new URL("./lookups.txt", import.meta.url), "utf8"));
const pool = mariadb.createPool({ host: "127.0.0.1", port: Number(process.env.MARIADB_PORT), user: "app", connectionLimit: 2 });
const app = express();
app.get("/users/:id", async (req, res) => {
  for (let i = 0; i < lookups; i += 1) {
    await pool.query({ sql: "select * from users where id = ?", rowsAsArray: true }, [Number(req.params.id)]);
  }
  res.send("user");
});
app.post("/users", (req, res) => res.send("made"));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = \`http://127.0.0.1:\${server.address().port}\`;
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`\${base}/users/\${i + 1}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
server.close();
await pool.end();
`;

const MARIADB_SUITE = `
const http = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const express = require("express");
const mariadb = require("mariadb");

const pool = mariadb.createPool({ host: "127.0.0.1", port: Number(process.env.MARIADB_PORT), user: "app", connectionLimit: 2 });
afterAll(() => pool.end());

function get(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

test("users", async () => {
  const lookups = Number(readFileSync(join(__dirname, "lookups.txt"), "utf8"));
  const app = express();
  app.get("/users/:id", async (req, res) => {
    for (let i = 0; i < lookups; i += 1) await pool.query("select * from users where id = ?", [Number(req.params.id)]);
    res.send("user");
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  for (const id of [1, 2, 3]) expect(await get(server, "/users/" + id)).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});
`;

async function mariadbProject(
  files: Record<string, string>,
  command: string,
  link: Record<string, string>,
  database: FakeMysql,
): Promise<Checked> {
  const made = await createProject({
    ...files,
    "lookups.txt": "1",
    ".gitignore": "node_modules\n",
    "downtrace.json": JSON.stringify({ check: { command } }),
  });
  projects.push(made);
  for (const [name, dir] of Object.entries(link)) {
    await mkdir(dirname(join(made.dir, "node_modules", name)), { recursive: true });
    await symlink(dir, join(made.dir, "node_modules", name), "dir");
  }
  await made.write("lookups.txt", "4");
  return check(made, ["--base", "HEAD"], { MARIADB_PORT: String(database.port) });
}

describe("a suite whose application queries MySQL through mariadb 3.5, imported as ESM", () => {
  let checked: Checked;
  let database: FakeMysql;
  beforeAll(async () => {
    database = await startFakeMysql();
    checked = await mariadbProject(
      { "app.mjs": MARIADB_APP },
      "node app.mjs",
      {
        express: EXPRESS_DIR,
        mariadb: rootOf("mariadb"),
      },
      database,
    );
  });
  afterAll(() => database.close());

  it("sees the lookups multiplied, in the text the application wrote, and exits 1", () => {
    expectLookupsMultiplied(checked);
    expect(route(checked.report, "GET /users/:id").operations[0]?.label).toBe("select * from users where id = ?");
    expect(checked.report.base?.observers.mysql).toBe("on");
  });
});

describe("a suite Jest runs, whose application queries MySQL through mariadb 3.4", () => {
  let checked: Checked;
  let database: FakeMysql;
  beforeAll(async () => {
    database = await startFakeMysql();
    checked = await mariadbProject(
      {
        "users.test.js": MARIADB_SUITE,
        "package.json": JSON.stringify({ name: "mariadb-jest", private: true, jest: { transform: {} } }),
      },
      "node node_modules/jest/bin/jest.js --runInBand",
      { jest: JESTS[0][1], express: EXPRESS4_DIR, mariadb: rootOf("mariadb34") },
      database,
    );
  });
  afterAll(() => database.close());

  it("sees the lookups the tests' own copy of the driver ran, multiplied", () => {
    expectLookupsMultiplied(checked);
  });
});

/**
 * Prisma's adapter for MySQL from CommonJS, as a NestJS application on Prisma 7.10 holds it: over the driver's
 * CommonJS bundle, whose classes are out of reach, and connected at start-up, before any request. The route asks the
 * adapter what Prisma's client would.
 */
const PRISMA_MARIADB_APP = `
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const express = require("express");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");

async function main() {
  const lookups = Number(readFileSync(join(__dirname, "lookups.txt"), "utf8"));
  const adapter = await new PrismaMariaDb(
    { host: "127.0.0.1", port: Number(process.env.MARIADB_PORT), user: "app", connectionLimit: 2 },
    { useTextProtocol: true },
  ).connect();
  const app = express();
  app.get("/users/:id", async (req, res) => {
    for (let i = 0; i < lookups; i += 1) {
      await adapter.queryRaw({
        sql: "SELECT id, email FROM users WHERE id = ?",
        args: [Number(req.params.id)],
        argTypes: [{ scalarType: "int", arity: "scalar" }],
      });
    }
    res.send("user");
  });
  app.post("/users", (req, res) => res.send("made"));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(base + "/users/" + (i + 1));
    if (res.status !== 200) throw new Error("status " + res.status);
  }
  server.close();
  await adapter.dispose();
}
main();
`;

const PRISMA_ADAPTER_DIR = dirname(dirname(createRequire(import.meta.url).resolve("@prisma/adapter-mariadb")));

describe("a suite whose application holds Prisma's adapter for MySQL from CommonJS, over mariadb's bundle", () => {
  let checked: Checked;
  let database: FakeMysql;
  beforeAll(async () => {
    database = await startFakeMysql();
    checked = await mariadbProject(
      { "app.cjs": PRISMA_MARIADB_APP },
      "node app.cjs",
      { express: EXPRESS_DIR, "@prisma/adapter-mariadb": PRISMA_ADAPTER_DIR },
      database,
    );
  });
  afterAll(() => database.close());

  it("sees the queries Prisma would send multiplied, and exits 1", () => {
    expectLookupsMultiplied(checked);
    expect(route(checked.report, "GET /users/:id").operations[0]?.label).toBe(
      "SELECT id, email FROM users WHERE id = ?",
    );
  });
});

describe("a suite Jest runs, whose application holds Prisma's adapter for MySQL over mariadb's bundle", () => {
  let checked: Checked;
  let database: FakeMysql;
  beforeAll(async () => {
    database = await startFakeMysql();
    checked = await mariadbProject(
      {
        "users.test.js": PRISMA_MARIADB_APP.replace("main();", 'test("users", main);'),
        "package.json": JSON.stringify({ name: "prisma-mariadb-jest", private: true, jest: { transform: {} } }),
      },
      "node node_modules/jest/bin/jest.js --runInBand",
      { jest: JESTS[0][1], express: EXPRESS4_DIR, "@prisma/adapter-mariadb": PRISMA_ADAPTER_DIR },
      database,
    );
  });
  afterAll(() => database.close());

  it("sees the queries the tests' own copy of the adapter sent, multiplied", () => {
    expectLookupsMultiplied(checked);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("a suite whose queries go through postgres.js, imported as ESM", () => {
  // The driver of Drizzle's `postgres-js` and of most Supabase backends. Its ESM copy never enters the module
  // cache, and its first request is a test's: both runs would lose it alike (ADR 0235).
  const POSTGRESJS_APP = `
import { readFileSync } from "node:fs";
import express from "express";
import postgres from "postgres";

const queries = Number(readFileSync(new URL("./queries.txt", import.meta.url), "utf8"));
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const app = express();
app.get("/orders/:id", async (req, res) => {
  for (let i = 0; i < queries; i += 1) await sql\`select \${req.params.id}::int + \${i}::int as line\`;
  res.send("order");
});
app.post("/orders", (req, res) => res.send("placed"));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = \`http://127.0.0.1:\${server.address().port}\`;
for (let i = 0; i < 3; i += 1) {
  const res = await fetch(\`\${base}/orders/\${i + 1}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
server.close();
await sql.end();
`;
  let checked: Checked;
  beforeAll(async () => {
    const made = await createProject({
      "app.mjs": POSTGRESJS_APP,
      "queries.txt": "1",
      ".gitignore": "node_modules\n",
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs" } }),
    });
    projects.push(made);
    await mkdir(join(made.dir, "node_modules"), { recursive: true });
    await symlink(EXPRESS_DIR, join(made.dir, "node_modules", "express"), "dir");
    await symlink(POSTGRESJS_DIR, join(made.dir, "node_modules", "postgres"), "dir");
    // The change: one query per line of the order, five a request.
    await made.write("queries.txt", "5");
    checked = await check(made, ["--base", "HEAD"]);
  });

  it("sees the queries multiplied from the first request on, and exits 1", () => {
    const orders = route(checked.report, "GET /orders/:id");
    expect(orders.verdict).toBe("worse");
    expect(orders.requests).toEqual({ base: 3, change: 3 });
    expect(orders.operations.find((operation) => operation.kind === "query")).toMatchObject({
      change: "multiplied",
      perRequest: { base: 1, change: 5 },
    });
    expect(checked.code).toBe(1);
  });
});

/**
 * Jest runs a test file's modules in a registry of its own, where neither the Express the instrumentation arms nor
 * the drivers it patches from Node's module cache are the ones the tests use (`jest.ts`). A suite as most Express
 * backends write theirs: routers mounted under routers, supertest's way of calling the application — Node's own
 * `http`, as supertest does — and Jest, in band.
 */
const JEST_APP = `
const express = require("express");
const http = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const calls = Number(readFileSync(join(__dirname, "calls.txt"), "utf8"));
const queries = Number(readFileSync(join(__dirname, "queries.txt"), "utf8"));
const pg = process.env.DATABASE_URL ? new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, max: 1 }) : undefined;

function fetchStock(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/stock" }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
  });
}

module.exports = (stockPort) => {
  const users = express.Router();
  users.get("/:userId", async (req, res, next) => {
    try {
      for (let i = 0; i < calls; i += 1) await fetchStock(stockPort);
      if (pg) for (let i = 0; i < queries; i += 1) await pg.query("select $1::int + $2::int as line", [req.params.userId, i]);
      res.send("user");
    } catch (err) { next(err); }
  });
  const v1 = express.Router();
  v1.use("/users", users);
  const app = express();
  app.use("/v1", v1);
  return { app, end: () => pg?.end() };
};
`;

const JEST_TEST = `
const http = require("node:http");
const makeApp = require("./app.js");

let stock;
let app;
beforeAll(async () => {
  stock = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => stock.listen(0, "127.0.0.1", resolve));
  app = makeApp(stock.address().port);
});
afterAll(async () => {
  await app.end();
  await new Promise((resolve) => stock.close(resolve));
});

function get(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

test("users", async () => {
  const server = app.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  for (const id of [1, 2, 3]) expect(await get(server, "/v1/users/" + id)).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});
`;

const JESTS = [
  ["Jest 30", dirname(createRequire(import.meta.url).resolve("jest/package.json"))],
  ["Jest 29", dirname(createRequire(import.meta.url).resolve("jest29/package.json"))],
] as const;

/** A project whose tests Jest runs, at `calls.txt` and `queries.txt` per request, with what the change sets. */
async function jestProject(jest: string, change: { calls: string; queries: string }): Promise<Checked> {
  const made = await createProject({
    "app.js": JEST_APP,
    "users.test.js": JEST_TEST,
    "calls.txt": "1",
    "queries.txt": "1",
    ".gitignore": "node_modules\n",
    "package.json": JSON.stringify({ name: "jest-suite", private: true, jest: { transform: {} } }),
    "downtrace.json": JSON.stringify({ check: { command: "node node_modules/jest/bin/jest.js --runInBand" } }),
  });
  projects.push(made);
  await mkdir(join(made.dir, "node_modules"), { recursive: true });
  await symlink(jest, join(made.dir, "node_modules", "jest"), "dir");
  await symlink(EXPRESS4_DIR, join(made.dir, "node_modules", "express"), "dir");
  await symlink(PG_DIR, join(made.dir, "node_modules", "pg"), "dir");
  await made.write("calls.txt", change.calls);
  await made.write("queries.txt", change.queries);
  return check(made, ["--base", "HEAD"]);
}

describe.each(JESTS)("a suite Jest runs, %s, as most Express backends are tested", (_name, jest) => {
  let checked: Checked;
  beforeAll(async () => {
    // The change: the route now calls its provider once per item, three times a request.
    checked = await jestProject(jest, { calls: "3", queries: "1" });
  });

  it("names the route by its mounts, and sees the calls multiplied", () => {
    const users = route(checked.report, "GET /v1/users/:userId");
    expect(users.verdict, JSON.stringify(checked.report.routes.map((r) => r.id))).toBe("worse");
    expect(users.requests).toEqual({ base: 3, change: 3 });
    expect(users.operations.find((operation) => operation.kind === "call")).toMatchObject({
      change: "multiplied",
      perRequest: { base: 1, change: 3 },
    });
    expect(checked.code).toBe(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("a suite Jest runs whose queries go through pg", () => {
  let checked: Checked;
  beforeAll(async () => {
    checked = await jestProject(JESTS[0][1], { calls: "1", queries: "4" });
  });

  it("sees the queries the tests' own copy of pg ran, multiplied", () => {
    const users = route(checked.report, "GET /v1/users/:userId");
    expect(users.verdict).toBe("worse");
    expect(users.operations.find((operation) => operation.kind === "query")).toMatchObject({
      change: "multiplied",
      perRequest: { base: 1, change: 4 },
    });
    expect(checked.report.change?.observers.pg).toBe("on");
  });
});

describe("the same code on both sides", () => {
  // «Given the same code on both sides, when check runs ten times, then no route is ever worse».
  it("is never worse, ten times in a row, and says it evaluated what it says is unchanged", async () => {
    const same = await project(appFiles({}));
    const runs: Checked[] = [];
    for (let batch = 0; batch < 2; batch += 1) {
      runs.push(...(await Promise.all(Array.from({ length: 5 }, () => check(same, ["--base", "HEAD"])))));
    }
    expect(runs).toHaveLength(10);
    for (const run of runs) {
      expect(run.report.status, run.stderr).toBe("compared");
      expect(run.report.routes.filter((one) => one.verdict === "worse")).toEqual([]);
      expect(run.code).toBe(0);
      expect(route(run.report, "GET /products").verdict).toBe("unchanged");
      expect(route(run.report, "POST /checkout").verdict).toBe("unchanged");
    }
  });
});

describe("two runs whose durations differ (LOC-01)", () => {
  it("get the same verdicts as two that do not: no verdict depends on a duration", async () => {
    const slow = await project(appFiles({}));
    await slow.write("regressions.json", JSON.stringify({ delayMs: 120 }));
    const checked = await check(slow, ["--base", "HEAD"]);
    const checkout = route(checked.report, "POST /checkout");
    // The change really is slower, by two orders of magnitude...
    expect(checkout.meanRequestMs.change ?? 0).toBeGreaterThan((checkout.meanRequestMs.base ?? 1) * 10);
    // ...and nothing is worse.
    expect(checked.report.routes.filter((one) => one.verdict === "worse")).toEqual([]);
    expect(checked.code).toBe(0);
  });
});

describe("what leaves the machine, and what is touched on it", () => {
  it("sends nothing: no run is given the token or the URL it was started with, and nothing connects out", async () => {
    const received: string[] = [];
    const sink = http.createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(202).end();
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const dir = await room();
    const connections = join(dir, "connections.txt");
    await writeFile(connections, "");
    try {
      const made = await project(appFiles({}));
      await made.write("regressions.json", JSON.stringify(REGRESSION));
      const tripwire = new URL("./support/network-tripwire.mjs", import.meta.url).href;
      const checked = await check(made, ["--base", "HEAD"], {
        // What a developer with production configured has in their shell: it must not reach the runs.
        DOWNTRACE_TOKEN: "dt_secret_token",
        DOWNTRACE_URL: `http://127.0.0.1:${(sink.address() as AddressInfo).port}`,
        NODE_OPTIONS: `--import=${tripwire}`,
        TRIPWIRE_FILE: connections,
      });
      expect(checked.report.status, checked.stderr).toBe("compared");
      expect(received).toEqual([]);
      const attempted = (await readFile(connections, "utf8")).split("\n").filter(Boolean);
      // The tripwire is live: it saw the application calling its provider, on this machine.
      expect(attempted.length).toBeGreaterThan(0);
      for (const target of attempted) expect(target, target).toMatch(/^(127\.0\.0\.1|localhost|::1|\[::1\]):\d+$/);
    } finally {
      await new Promise((resolve) => sink.close(resolve));
    }
  });

  it("leaves the working tree as it was: files, index, staged and unstaged changes, untracked and ignored files", async () => {
    const made = await project({ ...appFiles({}), ".gitignore": "node_modules/\nignored.log\n", "notes.txt": "one\n" });
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    await made.write("notes.txt", "one\ntwo\n");
    await made.git("add", "notes.txt");
    await made.write("notes.txt", "one\ntwo\nthree\n");
    await made.write("scratch.txt", "untracked\n");
    await made.write("ignored.log", "ignored\n");
    await made.write("node_modules/dep/index.js", "module.exports = 1;\n");
    await snapshot(made); // `git status` may refresh the index once; what is compared is after that
    const before = await snapshot(made);
    const tmp = await room();
    const checked = await check(made, ["--base", "HEAD"], { TMPDIR: tmp });
    expect(checked.report.status, checked.stderr).toBe("compared");
    expect(await snapshot(made)).toEqual(before);
    // The base was a worktree of its own and it is gone, from the repository's books and from the disk.
    expect(await worktrees(made)).toEqual([made.dir]);
    expect(await readdir(tmp)).toEqual([]);
    expect(await readdir(join(made.dir, ".git"))).not.toContain("worktrees");
  });

  it("does not let a package manager in the base rewrite the pnpm-workspace.yaml of the user", async () => {
    // What pnpm does when it runs: it looks upward for the nearest pnpm-workspace.yaml and rewrites it. The base
    // is checked out outside the repository, so what it finds going up is its own, never the user's.
    const rewrite = `
      import { readFile, writeFile } from "node:fs/promises";
      import { dirname, join } from "node:path";
      if (process.cwd() === process.env.PROJECT_DIR) process.exit(0);
      let dir = process.cwd();
      for (;;) {
        const path = join(dir, "pnpm-workspace.yaml");
        try {
          await writeFile(path, (await readFile(path, "utf8")) + "# rewritten\\n");
          console.log("rewrote " + path);
          break;
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
        if (dirname(dir) === dir) break;
        dir = dirname(dir);
      }
    `;
    // One project where the base has its own file, and one where only the working tree has it: the second is the
    // one a walk upward could reach the user's through.
    for (const tracked of [true, false]) {
      const made = await project({
        ...appFiles({}),
        "rewrite.mjs": rewrite,
        ...(tracked ? { "pnpm-workspace.yaml": "packages: []\n" } : {}),
      });
      await made.write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
      await made.write("regressions.json", JSON.stringify(REGRESSION));
      const before = await readFile(join(made.dir, "pnpm-workspace.yaml"), "utf8");
      const checked = await check(made, ["--base", "HEAD", "--", "sh", "-c", "node rewrite.mjs && node app.mjs"], {
        PROJECT_DIR: made.dir,
      });
      expect(checked.report.status, checked.stderr).toBe("compared");
      expect(await readFile(join(made.dir, "pnpm-workspace.yaml"), "utf8"), `tracked: ${tracked}`).toBe(before);
    }
  });

  it("refuses to make the base inside the repository: a walk upward from there would reach the user's files", async () => {
    const made = await project(appFiles({}));
    const inside = join(made.dir, "scratch");
    await mkdir(inside);
    const checked = await check(made, ["--base", "HEAD"], { TMPDIR: inside });
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "setup-failed", side: "base" });
    expect(checked.report.failure?.message).toContain("is inside the repository");
    expect(await readdir(inside)).toEqual([]);
  });
});

describe("the base of the project", () => {
  it("runs on the dependencies of the working tree, linked, and gives them back untouched", async () => {
    const files = appFiles({});
    const made = await project({
      ...files,
      "app.mjs": `import "fake-dep";\n${files["app.mjs"]}`,
      ".gitignore": "node_modules/\n",
    });
    await made.write(
      "node_modules/fake-dep/package.json",
      '{"name":"fake-dep","type":"module","exports":"./index.js"}',
    );
    await made.write("node_modules/fake-dep/index.js", "export default 1;\n");
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    const before = await snapshot(made);
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.status, checked.stderr + JSON.stringify(checked.report.failure)).toBe("compared");
    expect(await snapshot(made)).toEqual(before);
  });

  it("runs with the .env files git ignores, linked, as a project that reads one needs, and leaves them as they were", async () => {
    // fastify/demo's tests start with `tsx --env-file=.env`, and its .env is ignored: in a checkout of the base
    // there was none, and the base's run failed before a request was made.
    const files = appFiles({});
    const made = await project({
      ...files,
      "app.mjs": `import { readFileSync } from "node:fs";\nif (!readFileSync(".env", "utf8").includes("SECRET=")) throw new Error("no .env");\nif (!readFileSync("config/.env.test", "utf8").includes("MODE=")) throw new Error("no .env.test");\n${files["app.mjs"] ?? ""}`,
      ".gitignore": ".env\n.env.*\n",
      "config/settings.json": "{}\n",
    });
    await made.write(".env", "SECRET=hunter2-zq\n");
    await made.write("config/.env.test", "MODE=test\n");
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    const before = await snapshot(made);
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.status, checked.stderr + JSON.stringify(checked.report.failure)).toBe("compared");
    expect(route(checked.report, "POST /checkout").verdict).toBe("worse");
    expect(await snapshot(made)).toEqual(before);
  });

  it("leaves the base's own .env to the base, when the repository tracks one", async () => {
    // A tracked .env is the base's, and what it says is part of what is compared: the base's says one call.
    const files = appFiles({});
    const made = await project({
      ...files,
      "app.mjs": `import { readFileSync } from "node:fs";\n${(files["app.mjs"] ?? "").replace(
        'const regress = JSON.parse(await readFile(new URL("./regressions.json", import.meta.url), "utf8"));',
        '$&\nif (readFileSync(".env", "utf8").includes("PER_LINE=1")) regress.perLine = true;',
      )}`,
      ".env": "PER_LINE=0\n",
    });
    await made.write(".env", "PER_LINE=1\n");
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.status, checked.stderr + JSON.stringify(checked.report.failure)).toBe("compared");
    expect(route(checked.report, "POST /checkout").verdict).toBe("worse");
  });

  it("can be prepared, in the base and nowhere else, by what the configuration says", async () => {
    // Prepare turns the regression on in the base only: the base then does more than the working tree does, and
    // the working tree's own file is as it was.
    const made = await project({
      ...appFiles({}),
      "downtrace.json": JSON.stringify({
        check: {
          command: "node app.mjs",
          prepare: `test "$DOWNTRACE_CHECK_ORIGIN" != "$PWD" && echo '{"perLine":true}' > regressions.json`,
        },
      }),
    });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.status, checked.stderr).toBe("compared");
    const checkout = route(checked.report, "POST /checkout");
    expect(checkout.verdict).toBe("unchanged");
    expect(checkout.operations.find((operation) => operation.kind === "call")?.change).toBe("reduced");
    expect(await readFile(join(made.dir, "regressions.json"), "utf8")).toBe("{}");
  });

  it("says when the preparation fails, and that it is the base's setup", async () => {
    const made = await project({
      ...appFiles({}),
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs", prepare: "echo no >&2; exit 3" } }),
    });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "setup-failed", side: "base" });
    expect(checked.report.failure?.message).toContain("exited with 3");
    expect(checked.report.failure?.outputTail).toContain("no");
    // The working tree has no node_modules either: linking would have brought nothing, so it is not advised.
    expect(checked.report.failure?.advice).toBeNull();
  });

  /**
   * sahat/hackathon-starter, in the stranger campaign: its postinstall compiles the CSS the pages need into a file
   * git ignores, so the base's checkout has none and its pages answered 500. The base needs `prepare` to compile it,
   * and the compiler is in the working tree's node_modules, which `prepare` alone left unlinked. `fake-sass` is that
   * compiler; the application will not start without `styles.css`.
   */
  async function compiledCssProject(config: Record<string, unknown>): Promise<Project> {
    const files = appFiles({});
    const made = await project({
      ...files,
      "app.mjs": `import { readFileSync } from "node:fs";\nif (!readFileSync("styles.css", "utf8").includes("body")) throw new Error("no styles.css");\n${files["app.mjs"] ?? ""}`,
      ".gitignore": "node_modules/\nstyles.css\n.env\n",
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs", ...config } }),
    });
    await made.write(
      "node_modules/fake-sass/build.mjs",
      'import { writeFileSync } from "node:fs";\nwriteFileSync("styles.css", "body {}\\n");\n',
    );
    // What the postinstall left in the working tree, and the machine's configuration.
    await made.write("styles.css", "body {}\n");
    await made.write(".env", "SECRET=hunter2-zq\n");
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    return made;
  }

  it("links the working tree's dependencies before prepare runs, when link says so, and gives them back untouched", async () => {
    // The prepare also asserts what it runs with: the links already there, and no package manager that would
    // install through them on its own.
    const made = await compiledCssProject({
      link: true,
      prepare:
        'test -L node_modules && grep -q SECRET= .env && test "$npm_config_verify_deps_before_run" = false && ' +
        'test "$pnpm_config_verify_deps_before_run" = false && node node_modules/fake-sass/build.mjs',
    });
    const before = await snapshot(made);
    const tmp = await room();
    const checked = await check(made, ["--base", "HEAD"], { TMPDIR: tmp });
    expect(checked.report.status, checked.stderr + JSON.stringify(checked.report.failure)).toBe("compared");
    expect(route(checked.report, "POST /checkout").verdict).toBe("worse");
    expect(await snapshot(made)).toEqual(before);
    expect(await worktrees(made)).toEqual([made.dir]);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("links nothing when prepare is given without link, and says link when the prepare fails for want of them", async () => {
    const made = await compiledCssProject({ prepare: "node node_modules/fake-sass/build.mjs" });
    const before = await snapshot(made);
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "setup-failed", side: "base" });
    expect(checked.report.failure?.message).toContain("the prepare command exited with 1");
    expect(checked.report.failure?.outputTail).toContain("fake-sass");
    expect(checked.report.failure?.advice).toContain('"link": true');
    expect(checked.report.failure?.advice).toContain("If prepare does not install");
    expect(await snapshot(made)).toEqual(before);
  });

  /** A project whose application imports a package the working tree has installed, and git ignores. */
  async function dependentProject(config: Record<string, unknown>): Promise<Project> {
    const files = appFiles({});
    const made = await project({
      ...files,
      "app.mjs": `import "fake-dep";\n${files["app.mjs"] ?? ""}`,
      ".gitignore": "node_modules/\n",
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs", ...config } }),
    });
    await made.write(
      "node_modules/fake-dep/package.json",
      '{"name":"fake-dep","type":"module","exports":"./index.js"}',
    );
    await made.write("node_modules/fake-dep/index.js", "export default 1;\n");
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    return made;
  }

  it("says link when the base's tests fail with no dependencies, prepare given and link not", async () => {
    const made = await dependentProject({ prepare: "true" });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "base" });
    expect(checked.report.failure?.outputTail).toContain("fake-dep");
    expect(checked.report.failure?.advice).toContain("make the tests pass on HEAD");
    expect(checked.report.failure?.advice).toContain('"link": true');
  });

  it("names the file given with --config in that advice, which is where the key goes", async () => {
    const made = await dependentProject({});
    await made.write("ci/check.json", JSON.stringify({ check: { command: "node app.mjs", prepare: "true" } }));
    const checked = await check(made, ["--base", "HEAD", "--config", "ci/check.json"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "base" });
    expect(checked.report.failure?.advice).toContain('to "check" in ci/check.json');
    expect(checked.report.failure?.advice).not.toContain("downtrace.json");
  });

  it("refuses link with a prepare that installs before it checks anything out", async () => {
    const made = await dependentProject({ link: true, prepare: "pnpm install --offline && pnpm build" });
    const before = await snapshot(made);
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "bad-config", side: null });
    expect(checked.report.failure?.message).toContain("(pnpm install)");
    expect(await snapshot(made)).toEqual(before);
    expect(await worktrees(made)).toEqual([made.dir]);
  });

  it("takes the links away when the prepare fails after them, and follows none of them", async () => {
    const made = await compiledCssProject({ link: true, prepare: "test -L node_modules && echo linked && exit 3" });
    const before = await snapshot(made);
    const tmp = await room();
    const checked = await check(made, ["--base", "HEAD"], { TMPDIR: tmp });
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "setup-failed", side: "base" });
    expect(checked.report.failure?.message).toContain("exited with 3");
    expect(checked.report.failure?.outputTail).toContain("linked");
    // Linked already, so there is nothing to advise about linking.
    expect(checked.report.failure?.advice).toBeNull();
    expect(await snapshot(made)).toEqual(before);
    expect(await worktrees(made)).toEqual([made.dir]);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("links nothing when link is false and there is no prepare, as the key says", async () => {
    const made = await dependentProject({ link: false });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "base" });
    expect(checked.report.failure?.outputTail).toContain("fake-dep");
    // The person said false: the report does not argue with it.
    expect(checked.report.failure?.advice).not.toContain('"link"');
  });

  /**
   * parse-community/parse-server, in the stranger campaign: its specs require `lib/`, the Babel build of `src/` that git
   * ignores, so the base's checkout had none, and its first spec failed on `Cannot find module '../lib/…'` with nothing
   * said of why. The advice names what the base lacks and the prepare that builds it; with that prepare, the base runs.
   */
  async function builtLibProject(config: Record<string, unknown>): Promise<Project> {
    const files = appFiles({});
    const made = await project({
      ...files,
      "app.mjs": `import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./lib/greeting");\n${files["app.mjs"] ?? ""}`,
      "src/greeting.js": 'module.exports = "hi";\n',
      "build.mjs":
        'import { copyFileSync, mkdirSync } from "node:fs";\nmkdirSync("lib", { recursive: true });\n' +
        'copyFileSync("src/greeting.js", "lib/greeting.js");\n',
      "package.json": JSON.stringify({ name: "built-lib", private: true, scripts: { build: "node build.mjs" } }),
      "package-lock.json": "{}\n",
      ".gitignore": "node_modules/\nlib/\n",
      "downtrace.json": JSON.stringify({ check: { command: "node app.mjs", ...config } }),
    });
    // What the build left in the working tree.
    await made.write("lib/greeting.js", 'module.exports = "hi";\n');
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    return made;
  }

  it("says what a base lacks that a build makes, and the prepare that builds it", async () => {
    const made = await builtLibProject({});
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "base" });
    expect(checked.report.failure?.outputTail).toContain("Cannot find module './lib/greeting'");
    const advice = checked.report.failure?.advice ?? "";
    expect(advice).toContain("The base has no lib/");
    expect(advice).toContain('"prepare": "npm run build"');
    expect(advice).toContain('"link": true');

    // The advice, followed: the base builds, and the comparison is made.
    const followed = await builtLibProject({ prepare: "npm run build", link: true });
    const compared = await check(followed, ["--base", "HEAD"]);
    expect(compared.report.status, JSON.stringify(compared.report.failure)).toBe("compared");
    expect(route(compared.report, "POST /checkout").verdict).toBe("worse");
  });

  it("says the prepare did not make what the base lacks, when one was given", async () => {
    const made = await builtLibProject({ prepare: "true", link: true });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "base" });
    expect(checked.report.failure?.advice).toContain("prepare ran and did not make it");
  });

  it("is a project inside a repository: the base runs in the same directory of its checkout", async () => {
    const inner = Object.fromEntries(
      Object.entries(appFiles({})).map(([path, text]) => [`services/api/${path}`, text]),
    );
    const made = await project(inner);
    await made.write("services/api/regressions.json", JSON.stringify(REGRESSION));
    const checked = await check(made, ["--base", "HEAD"], {}, { cwd: join(made.dir, "services", "api") });
    expect(checked.report.status, checked.stderr).toBe("compared");
    expect(route(checked.report, "POST /checkout").verdict).toBe("worse");
  });
});

describe("what goes wrong, said (COB-01)", () => {
  it("a base that does not run: the command fails on it, and that is said of the base, with its output", async () => {
    const made = await createProject({ ...appFiles({}), "app.mjs": "const = ;\n" });
    projects.push(made);
    await made.write("app.mjs", appFiles({})["app.mjs"] ?? "");
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.status).toBe("failed");
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "base" });
    expect(checked.report.failure?.outputTail).toContain("SyntaxError");
    expect(checked.report.routes).toEqual([]);
    // It stopped there: the change was not run on a base that did not.
    expect(checked.report.change).toBeNull();
  });

  it("a change that does not run: the command fails on it, and that is said of the change", async () => {
    const made = await project(appFiles({}));
    await made.write("app.mjs", "throw new Error('the change does not start');\n");
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "command-failed", side: "change" });
    expect(checked.report.failure?.outputTail).toContain("the change does not start");
    expect(checked.report.base?.exitCode).toBe(0);
  });

  it("a run that left no profile is said, with what happens and what to use, and is never unchanged", async () => {
    const made = await project(appFiles({}));
    // The instrumentation is not loaded in this run, which is what a runner that does not pass NODE_OPTIONS on is:
    // no process writes anything, and that is said. The runner the command names is still named, since nothing in
    // the command says which of the two it was.
    const checked = await check(made, [
      "--base",
      "HEAD",
      "--",
      "env",
      "-u",
      "NODE_OPTIONS",
      "node",
      "app.mjs",
      "--pool=threads",
    ]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({
      code: "no-profile",
      side: "base",
      message: "the run left no profile: no process of it wrote anything",
    });
    expect(checked.report.base?.processes).toBe(0);
    expect(checked.report.failure?.advice).toContain("Most likely the instrumentation loaded in no process");
    expect(checked.report.failure?.advice).toContain("This happens with Vitest with the threads or vmThreads pool");
    expect(checked.report.failure?.advice).toContain("use --pool=forks");
    expect(checked.report.summary).toBeNull();
    const text = (
      await downtrace(["check", "--base", "HEAD", "--", "env", "-u", "NODE_OPTIONS", "node", "app.mjs"], {
        cwd: made.dir,
      }).done
    ).stdout;
    expect(text).toContain("the run left no profile");
    expect(text).not.toMatch(/unchanged/i);
  });

  // The stranger campaign: `NODE_OPTIONS=--max-old-space-size=4096 npm test`, and a Jest ESM suite whose script is
  // `NODE_OPTIONS=--experimental-vm-modules jest`, replace the NODE_OPTIONS check loads the instrumentation with, and
  // the report blamed Vitest's pool.
  it("a command that replaces NODE_OPTIONS: no process loaded the instrumentation, which is said with how to keep it", async () => {
    const made = await project(appFiles({}));
    const command = ["NODE_OPTIONS=--max-old-space-size=512", "node", "app.mjs"];
    const checked = await check(made, ["--base", "HEAD", "--", ...command]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({
      code: "no-profile",
      side: "base",
      message: "the run left no profile: no process of it wrote anything",
    });
    expect(checked.report.base?.processes).toBe(0);
    const advice = checked.report.failure?.advice ?? "";
    expect(advice).toContain("The instrumentation loaded in no process");
    expect(advice).toContain("the test command sets NODE_OPTIONS=--max-old-space-size=512");
    expect(advice).toContain('NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=512"');
    expect(advice).not.toContain("--pool");
    // What the link to tell Downtrace carries is the message, never the command.
    const body = new URL(checked.report.feedback?.url ?? "").searchParams.get("body") ?? "";
    expect(body).toContain("no process of it wrote anything");
    expect(body).not.toContain("max-old-space-size");

    const text = (await downtrace(["check", "--base", "HEAD", "--", ...command], { cwd: made.dir }).done).stdout;
    expect(text).toContain("base: the run left no profile: no process of it wrote anything");
    expect(text).toContain('NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=512"');
  });

  // What this test used to allow: a run that ends with `process.exit()` was said to have no profile, or compared on
  // part of one. The instrumentation writes what it holds when the process exits when it only writes a file, which
  // is what a run of `check` is, so the profile is there and the comparison is made (DT-79, ADR 0230).
  it("a run that ends the process without waiting keeps its profile and is compared", async () => {
    const made = await project({ ...appFiles({}), "app.mjs": `${appFiles({})["app.mjs"] ?? ""}\nprocess.exit(0);\n` });
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.report.status, JSON.stringify(checked.report.failure)).toBe("compared");
    const evaluated = checked.report.routes.filter((r) => r.verdict !== "not-evaluated");
    expect(evaluated.length, "a route was evaluated").toBeGreaterThan(0);
    for (const one of evaluated) {
      expect(one.profiledRequests.base, one.id).toBeGreaterThan(0);
      expect(one.profiledRequests.change, one.id).toBeGreaterThan(0);
    }
  });

  it("a run in which no route could be evaluated says so, and names why for each", async () => {
    const made = await project(appFiles({ traffic: [["GET", "/health", 3]] }));
    const checked = await check(made, ["--base", "HEAD"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "nothing-evaluated" });
    expect(route(checked.report, "GET /health").reasons[0]?.code).toBe("nothing-observed");
    expect(route(checked.report, "GET /orders").reasons[0]?.code).toBe("not-called");
    // A run that could evaluate nothing is one Downtrace wants to hear about, from the person, if they want: a link
    // to an issue filled in with the codes and nothing of the project's routes.
    const url = checked.report.feedback?.url ?? "";
    expect(url.startsWith("https://github.com/RadW2020/downtrace-agent/issues/new?")).toBe(true);
    const body = new URL(url).searchParams.get("body") ?? "";
    expect(body).toContain("nothing-evaluated");
    for (const path of ["/health", "/orders"]) expect(body, path).not.toContain(path);
  });

  it("a ref that does not exist", async () => {
    const made = await project(appFiles({}));
    const checked = await check(made, ["--base", "no-such-branch"]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "bad-ref" });
    expect(checked.report.failure?.message).toContain("no-such-branch");
    expect(checked.report.failure?.advice).toContain("--base");
  });

  it("a ref that is an option", async () => {
    const made = await project(appFiles({}));
    const checked = await check(made, ["--base=--output=/tmp/x"]);
    expect(checked.report.failure).toMatchObject({ code: "bad-ref" });
  });

  it("a directory that is not a repository", async () => {
    const dir = await room();
    const { done } = downtrace(["check", "--json", "--", "node", "-e", "0"], { cwd: dir });
    const result = await done;
    const report = JSON.parse(result.stdout) as CheckReport;
    expect(result.code).toBe(2);
    expect(report.failure).toMatchObject({ code: "not-a-repository" });
  });

  it("no test command anywhere", async () => {
    const made = await project({ "readme.txt": "x" });
    const checked = await check(made, []);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "no-command" });
    expect(checked.report.failure?.advice).toContain("downtrace check -- npm test");
  });

  it("a configuration that cannot be read", async () => {
    const made = await project({ ...appFiles({}), "downtrace.json": '{"check":{"commmand":"x"}}' });
    const checked = await check(made, []);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "bad-config" });
    expect(checked.report.failure?.message).toContain("check.commmand");
  });

  it("a test command given on the command line takes the place of the configured one", async () => {
    const made = await project({ ...appFiles({}), "downtrace.json": '{"check":{"command":"exit 7"}}' });
    const checked = await check(made, ["--base", "HEAD", "--", "node", "app.mjs"]);
    expect(checked.report.status, checked.stderr).toBe("compared");
  });

  it("a run that does not end in time: stopped, with what it started, and said", async () => {
    const dir = await room();
    const pidFile = join(dir, "pid.txt");
    const made = await project(appFiles({}));
    const checked = await check(made, [
      "--base",
      "HEAD",
      "--timeout",
      "1",
      "--",
      "sh",
      "-c",
      `echo $$ > ${pidFile}; sleep 60`,
    ]);
    expect(checked.code).toBe(2);
    expect(checked.report.failure).toMatchObject({ code: "timeout", side: "base" });
    expect(await alive(await pidIn(pidFile)), "the command is still running").toBe(false);
    expect(await worktrees(made)).toEqual([made.dir]);
  });

  it("a signal in the middle of a run: it stops what it started, takes the worktree away and says it was interrupted", async () => {
    const dir = await room();
    const pidFile = join(dir, "pid.txt");
    const tmp = await room();
    const made = await project(appFiles({}));
    let running: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });
    const { done, child } = downtrace(
      ["check", "--json", "--base", "HEAD", "--", "sh", "-c", `echo $$ > ${pidFile}; sleep 60`],
      {
        cwd: made.dir,
        env: cleanEnv({ TMPDIR: tmp }),
        onStderr: (text) => {
          if (text.includes("base: running")) running();
        },
      },
    );
    await started;
    const pid = await pidIn(pidFile);
    child.kill("SIGTERM");
    const result = await done;
    const report = JSON.parse(result.stdout) as CheckReport;
    expect(result.code).toBe(2);
    expect(report.failure).toMatchObject({ code: "interrupted" });
    expect(await alive(pid), "the command is still running").toBe(false);
    expect(await worktrees(made)).toEqual([made.dir]);
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("the exit status and the text, for CI and for a person", () => {
  it("exits 0 and says what was left out when nothing is worse", async () => {
    const made = await project(appFiles({}));
    const { done } = downtrace(["check", "--base", "HEAD"], { cwd: made.dir });
    const result = await done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("routes evaluated: 0 worse,");
    expect(result.stdout).toContain("Not evaluated (");
    expect(result.stdout).not.toContain("Worse (");
  });

  it("exits 1 and puts the route under Worse when one is", async () => {
    const made = await project(appFiles({}));
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    const result = await downtrace(["check", "--base", "HEAD"], { cwd: made.dir }).done;
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Worse (1)");
    expect(result.stdout).toMatch(/POST \/checkout/);
  });

  it("says a database the project depends on and no observer found, and not one it does not depend on", async () => {
    // With the runner's package store off `NODE_PATH`, nothing resolves but what the project has: it declares mysql2
    // and has not installed it, and it neither declares nor has pg.
    const made = await project({
      ...appFiles(REGRESSION),
      "package.json": JSON.stringify({ name: "declares-mysql", private: true, dependencies: { mysql2: "^3" } }),
    });
    const checked = await check(made, ["--base", "HEAD"], { NODE_PATH: "" });
    expect(checked.report.status, JSON.stringify(checked.report.failure)).toBe("compared");
    expect(checked.report.base?.observers.mysql).toBeUndefined();
    expect(checked.report.base?.observers.pg).toBe("unavailable");
    const notes = checked.report.notes.join("\n");
    for (const side of ["base", "change"]) {
      expect(notes).toContain(`On the ${side}, the project depends on mysql2 and the mysql observer found no driver`);
    }
    expect(notes).not.toContain("pg observer");
  });

  it("compares the working tree with a commit that is not HEAD", async () => {
    const made = await project(appFiles({}));
    const first = (await made.git("rev-parse", "HEAD")).trim();
    await made.write("regressions.json", JSON.stringify(REGRESSION));
    await made.git("commit", "--quiet", "-am", "the regression");
    // The tree is clean and equal to HEAD: against HEAD nothing changed; against the first commit it did.
    const againstHead = await check(made, ["--base", "HEAD"]);
    const againstFirst = await check(made, ["--base", first]);
    expect(againstHead.report.summary?.worse).toBe(0);
    expect(againstFirst.report.summary?.worse).toBe(1);
    expect(againstFirst.report.base?.commit).toBe(first);
  });
});
