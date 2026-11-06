// The commands a consumer runs, on the Node that runs this file: `check`, `report`, `compare` and `verify` on a small
// project, with every answer pinned (DT-167, RF-121). `scripts/pack-test.sh` runs it against the installed package on
// each Node CI consumes the package on, 18.19.0 included; `consumer-commands.test.ts` runs it against the source on the
// Node the package is built with, which is what makes the pinned answers that Node's.
//
// Plain JavaScript and Node's own modules, so that the oldest supported Node runs it as it is.
//
// Usage: node consumer-commands.mjs <the file `downtrace` runs> <the URL of @downtrace/agent/register>
// Prints a line per answer as pinned; at the first one that is not, says what it was instead and exits 1.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [command, register] = process.argv.slice(2);
if (command === undefined || register === undefined) {
  process.stderr.write("usage: node consumer-commands.mjs <the file downtrace runs> <the URL of the register entry>\n");
  process.exit(2);
}
/** Where it is named from here, run from the project's own directory. */
const cli = resolve(command);

/** What every child inherits: nothing that points the instrumentation at a cloud, and no preload of the caller's. */
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("DOWNTRACE_") && name !== "NODE_OPTIONS"),
);

function run(file, args, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const downtrace = (args, options) => run(process.execPath, [cli, ...args], options);

/** An answer that is not the one pinned: what it was, and what was wanted. */
class Mismatch extends Error {}

/** Says the answer was as pinned, or throws what it was instead. */
function expectAnswer(what, result, code, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (result.code === code && same) {
    console.log(`  ${what}: exit ${code}, as pinned`);
    return;
  }
  const lines = [`✗ ${what}: exit ${result.code}, want ${code}`];
  if (!same) lines.push(`  answered ${JSON.stringify(got)}`, `  want     ${JSON.stringify(want)}`);
  lines.push(`  stdout: ${result.stdout.slice(0, 2000)}`, `  stderr: ${result.stderr.slice(0, 2000)}`);
  throw new Mismatch(lines.join("\n"));
}

/** What a report says, read as JSON; or what it printed, when it printed no JSON. */
function parsed(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { printed: result.stdout };
  }
}

/** The part of a check or compare report that does not depend on the machine: no duration, no commit, no path. */
const verdicts = (report) => ({
  status: report.status,
  summary: report.summary,
  failure: report.failure?.code ?? null,
  routes: (report.routes ?? []).map((route) => ({
    id: route.id,
    verdict: route.verdict,
    reasons: route.reasons.map((reason) => reason.code),
    requests: route.requests,
    operations: route.operations.map((op) => [op.id, op.change, op.worse, op.perRequest]),
  })),
});

/** The same, of a report on one file. */
const reported = (report) => ({
  status: report.status,
  requests: report.file?.requests,
  routes: (report.routes ?? []).map((route) => ({
    id: route.id,
    requests: route.requests,
    repeated: route.repeated.map((op) => [op.id, op.perRequest]),
  })),
});

/**
 * The application: `GET /users/<id>` calls the provider `perUser` times over `node:http`, `GET /orders` once with
 * `fetch`, `GET /health` nothing. The provider runs in the same process, as a test's stub does, so its own two
 * routes are observed too, with nothing inside them.
 */
const app = (perUser) => `import http from "node:http";

export async function start() {
  const provider = http.createServer((req, res) => {
    req.resume();
    res.end("{}");
  });
  await new Promise((ready) => provider.listen(0, "127.0.0.1", ready));
  const port = provider.address().port;
  const call = (path) =>
    new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });
  const app = http.createServer(async (req, res) => {
    req.resume();
    if (req.url.startsWith("/users/")) for (let i = 0; i < ${perUser}; i++) await call("/profile");
    if (req.url === "/orders") await (await fetch(\`http://127.0.0.1:\${port}/stock\`)).text();
    res.end("ok");
  });
  await new Promise((ready) => app.listen(0, "127.0.0.1", ready));
  return {
    port: app.address().port,
    close() {
      app.close();
      provider.closeAllConnections();
      provider.close();
    },
  };
}
`;

const TEST = `import assert from "node:assert";
import http from "node:http";
import { test } from "node:test";
import { start } from "../app.mjs";

const get = (port, path) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });

test("every route answers", async () => {
  const app = await start();
  for (const path of ["/users/1", "/users/2", "/users/3", "/orders", "/health"]) assert.equal(await get(app.port, path), 200);
  app.close();
});
`;

const COMMAND = ["--", "node", "--test", "test/app.test.mjs"];

/**
 * What each command answers on the Node the package is built with. Every call, `fetch`'s and `node:http`'s alike, is
 * one operation: a call to this machine is the same operation on any port. A route of the provider has nothing inside.
 */
const route = (id, verdict, base, change, operations = []) => ({
  id,
  verdict,
  reasons: verdict === "not-evaluated" ? ["nothing-observed"] : [],
  requests: { base, change },
  operations,
});
const call = (movement, worse, base, change) => ["call:GET 127.0.0.1", movement, worse, { base, change }];
const nothingInside = (profiles) => [
  route("GET /health", "not-evaluated", 1, 1),
  route("GET /profile", "not-evaluated", 3, profiles),
  route("GET /stock", "not-evaluated", 1, 1),
];
const ordersUnchanged = route("GET /orders", "unchanged", 1, 1, [call("unchanged", false, 1, 1)]);
const PINNED = {
  unchanged: {
    status: "compared",
    summary: { worse: 0, unchanged: 2, notEvaluated: 3 },
    failure: null,
    routes: [
      ordersUnchanged,
      route("GET /users/:id", "unchanged", 3, 3, [call("unchanged", false, 1, 1)]),
      ...nothingInside(3),
    ],
  },
  worse: {
    status: "compared",
    summary: { worse: 1, unchanged: 1, notEvaluated: 3 },
    failure: null,
    routes: [
      route("GET /users/:id", "worse", 3, 3, [call("multiplied", true, 1, 2)]),
      ordersUnchanged,
      ...nothingInside(6),
    ],
  },
  report: {
    status: "reported",
    requests: 12,
    routes: [
      { id: "GET /profile", requests: 6, repeated: [] },
      { id: "GET /users/:id", requests: 3, repeated: [["call:GET 127.0.0.1", 2]] },
      { id: "GET /health", requests: 1, repeated: [] },
      { id: "GET /orders", requests: 1, repeated: [] },
      { id: "GET /stock", requests: 1, repeated: [] },
    ],
  },
};

const GIT = ["-c", "user.name=consumer", "-c", "user.email=consumer@example.com", "-c", "commit.gpgsign=false"];

const room = await realpath(await mkdtemp(join(tmpdir(), "downtrace-consumer-")));
const dir = join(room, "project");
try {
  await mkdir(join(dir, "test"), { recursive: true });
  await writeFile(join(dir, "app.mjs"), app(1));
  await writeFile(join(dir, "test", "app.test.mjs"), TEST);
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["add", "-A"],
    ["commit", "--quiet", "-m", "base"],
  ]) {
    const git = await run("git", [...GIT, ...args], { cwd: dir });
    if (git.code !== 0) throw new Error(`git ${args[0]} failed: ${git.stderr}`);
  }
  /** Runs the tests with the instrumentation writing to `file`, as a person records one side of a comparison. */
  const record = async (file) => {
    const recorded = await run(process.execPath, COMMAND.slice(2), {
      cwd: dir,
      env: { DOWNTRACE_INSPECT: file, NODE_OPTIONS: `--import ${register}` },
    });
    if (recorded.code !== 0) throw new Error(`the tests failed while recording ${file}: ${recorded.stderr}`);
  };

  const unchanged = await downtrace(["check", "--json", ...COMMAND], { cwd: dir });
  expectAnswer("check, nothing changed", unchanged, 0, verdicts(parsed(unchanged)), PINNED.unchanged);
  await record(join(room, "base.jsonl"));

  await writeFile(join(dir, "app.mjs"), app(2));
  const worse = await downtrace(["check", "--json", ...COMMAND], { cwd: dir });
  expectAnswer("check, a route that calls twice what it called once", worse, 1, verdicts(parsed(worse)), PINNED.worse);
  await record(join(room, "change.jsonl"));

  const report = await downtrace(["report", "--json", join(room, "change.jsonl")], { cwd: room });
  expectAnswer("report", report, 0, reported(parsed(report)), PINNED.report);
  const compare = await downtrace(["compare", "--json", join(room, "base.jsonl"), join(room, "change.jsonl")], {
    cwd: room,
  });
  expectAnswer("compare", compare, 1, verdicts(parsed(compare)), PINNED.worse);

  // A cloud of its own, which knows one token and says where it writes, as Downtrace's does.
  const cloud = http.createServer((req, res) => {
    req.resume();
    if (req.method !== "GET" || req.url !== "/v0/destination") return res.writeHead(404).end();
    if (req.headers.authorization !== "Bearer dt_consumer") return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end('{"project":"consumer","environment":"staging"}');
  });
  await new Promise((ready) => cloud.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${cloud.address().port}`;
  try {
    const known = await downtrace(["verify", "--token", "dt_consumer", "--url", url], { cwd: room });
    expectAnswer(
      "verify, a token the cloud knows",
      known,
      0,
      [known.stdout, known.stderr],
      ["downtrace verify: the token writes to consumer / staging\n", ""],
    );
    const unknown = await downtrace(["verify"], {
      cwd: room,
      env: { DOWNTRACE_DSN: `http://dt_other@127.0.0.1:${cloud.address().port}` },
    });
    expectAnswer(
      "verify, a token it does not",
      unknown,
      1,
      [unknown.stdout, unknown.stderr],
      ["", `downtrace verify: the cloud at ${url} refused the token (401): it does not know it, or it was revoked\n`],
    );
  } finally {
    cloud.close();
  }
} catch (err) {
  if (!(err instanceof Mismatch)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(room, { recursive: true, force: true });
}
