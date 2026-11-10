import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompareReport } from "../src/check/compare-command.ts";
import type { RouteReport } from "../src/check/report-command.ts";
import { type CliResult, cleanEnv, downtrace, REGISTER_URL } from "./support/check-project.ts";

/**
 * `downtrace report` and `downtrace compare` over what the instrumentation really writes: an application started with
 * `DOWNTRACE_INSPECT`, as a person starts it, used, and ended — twice into the same file, as a file that nothing rotates
 * holds the batches of every process that wrote to it. The base looks each user up once per request; the change, four
 * times.
 */

const run = promisify(execFile);
const EXPRESS_DIR = dirname(createRequire(import.meta.url).resolve("express/package.json"));
const BETTER_SQLITE3_DIR = dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json"));

const APP = `
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
app.get("/health", (req, res) => res.send("ok"));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = \`http://127.0.0.1:\${server.address().port}\`;
for (const path of ["/users/1", "/users/2", "/users/3", "/health"]) {
  const res = await fetch(\`\${base}\${path}\`);
  if (res.status !== 200) throw new Error(\`status \${res.status}\`);
}
server.close();
db.close();
`;

let dir: string;
let report: CliResult;
let compared: CliResult;
let same: CliResult;

/** Starts the application `times` times, each a process of its own, writing into `file`. */
async function record(file: string, lookups: number, times: number): Promise<void> {
  await writeFile(join(dir, "lookups.txt"), String(lookups));
  for (let i = 0; i < times; i += 1) {
    await run(process.execPath, [`--import=${REGISTER_URL}`, "app.mjs"], {
      cwd: dir,
      env: cleanEnv({ DOWNTRACE_INSPECT: join(dir, file) }),
      timeout: 60_000,
    });
  }
}

const cli = (args: string[]) => downtrace(args, { cwd: dir }).done;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-inspect-commands-")));
  await writeFile(join(dir, "app.mjs"), APP);
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", dependencies: { express: "5" } }));
  await mkdir(join(dir, "node_modules"));
  await symlink(EXPRESS_DIR, join(dir, "node_modules", "express"), "dir");
  await symlink(BETTER_SQLITE3_DIR, join(dir, "node_modules", "better-sqlite3"), "dir");
  await record("base.jsonl", 1, 2);
  await record("change.jsonl", 4, 2);
  [report, compared, same] = await Promise.all([
    cli(["report", "--json", "change.jsonl"]),
    cli(["compare", "--json", "base.jsonl", "change.jsonl"]),
    cli(["compare", "change.jsonl", "change.jsonl"]),
  ]);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("downtrace report, over a file two processes of an application wrote", () => {
  it("adds up both processes, and ends with 0", () => {
    expect(report.code, report.stderr).toBe(0);
    expect((JSON.parse(report.stdout) as RouteReport).file).toMatchObject({
      processes: 2,
      requests: 8,
      routes: 2,
      malformed: 0,
    });
  });

  it("says the queries per request of each route, the repeated lookup first", () => {
    const [users, health] = (JSON.parse(report.stdout) as RouteReport).routes;
    expect(users).toMatchObject({
      id: "GET /users/:id",
      requests: 6,
      profiledRequests: 6,
      queriesPerRequest: { mean: 4, median: { from: 3, to: 5 }, severalDatabases: false },
    });
    expect(users?.repeated.map((one) => [one.kind, one.label, one.perRequest])).toEqual([
      ["query", 'select * from "users" where "id" = ?', 4],
    ]);
    expect(users?.slowest).toHaveLength(1);
    expect(health).toMatchObject({ id: "GET /health", requests: 2, queriesPerRequest: { mean: 0 } });
  });
});

describe("downtrace compare, over two files recorded by hand", () => {
  it("calls the route whose lookup multiplied worse, as check would, and ends with 1", () => {
    expect(compared.code, compared.stderr).toBe(1);
    const said = JSON.parse(compared.stdout) as CompareReport;
    expect(said.summary).toEqual({ worse: 1, unchanged: 0, notEvaluated: 1 });
    expect(said.routes[0]).toMatchObject({
      id: "GET /users/:id",
      verdict: "worse",
      operations: [{ change: "multiplied", perRequest: { base: 1, change: 4 } }],
    });
  });

  it("changes nothing between a file and itself, and ends with 0", () => {
    expect(same.code, same.stderr).toBe(0);
    expect(same.stdout).toContain("1 of 2 routes evaluated: 0 worse, 1 unchanged.");
  });
});
