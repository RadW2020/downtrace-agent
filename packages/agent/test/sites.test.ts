import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apart, enterRequest, type RequestContext, recordOperationIn } from "../src/context.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { instrumentPg } from "../src/instrument/pg.ts";
import type { Logger } from "../src/log.ts";
import { CallSites, placeOf, SITES_PER_OPERATION } from "../src/sites.ts";
import { cleanEnv, REGISTER_URL } from "./support/check-project.ts";

/**
 * Where the application ran an operation, under `check` (RF-526): taken from the stack at the application's call, read
 * as a file of the project and a line, and written to a file of the run's own, never to a batch.
 *
 * The calls are made from modules written into a project of the test's own: a frame of this package's tests is a
 * frame of this package, and this package is never a place.
 */
// covers: RF-526

const quiet: Logger = { warn: () => {}, debug: () => {} };

/** `fn()` on a line of its own, in a file of the project: the place a call made through it has. */
const CALLER = `export function call(fn) {
  return fn();
}

export function loop(times, fn) {
  const out = [];
  for (let i = 0; i < times; i += 1) {
    out.push(fn());
  }
  return out;
}

export const one = (fn) => fn();
export const two = (fn) => fn();
export const three = (fn) => fn();
export const four = (fn) => fn();
`;
/** The line of each place in `CALLER`, read from it. */
const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
const CALL_LINE = lineOf(CALLER, "return fn();");
const LOOP_LINE = lineOf(CALLER, "out.push(fn());");

let root: string;
let project: string;
let caller: {
  call: <T>(fn: () => T) => T;
  loop: <T>(times: number, fn: () => T) => T[];
  one: <T>(fn: () => T) => T;
  two: <T>(fn: () => T) => T;
  three: <T>(fn: () => T) => T;
  four: <T>(fn: () => T) => T;
};
let viaLibrary: <T>(fn: () => T) => T;
let outside: <T>(fn: () => T) => T;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "downtrace-sites-")));
  project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "node_modules", "lib"), { recursive: true });
  await writeFile(join(project, "src", "caller.mjs"), CALLER);
  // A dependency in between: its frame is not the project's, and the project's frame below it is the place.
  await writeFile(join(project, "node_modules", "lib", "index.mjs"), "export const via = (fn) => fn();\n");
  await writeFile(
    join(project, "src", "through.mjs"),
    'import { via } from "../node_modules/lib/index.mjs";\n\nexport const through = (fn) => via(fn);\n',
  );
  await writeFile(join(root, "elsewhere.mjs"), "export const call = (fn) => fn();\n");
  caller = await import(pathToFileURL(join(project, "src", "caller.mjs")).href);
  viaLibrary = (await import(pathToFileURL(join(project, "src", "through.mjs")).href)).through;
  outside = (await import(pathToFileURL(join(root, "elsewhere.mjs")).href)).call;
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** A stack taken where `fn` runs. */
function taken(): { stack?: unknown } {
  const frames: { stack?: unknown } = {};
  Error.captureStackTrace(frames);
  return frames;
}

describe("the place of a stack", () => {
  it("is the innermost frame of the project, as a file relative to it and a line", () => {
    expect(placeOf(caller.call(taken), project)).toBe(`src/caller.mjs:${CALL_LINE}`);
  });

  it("is never a frame in node_modules: the project's frame that called the dependency is", () => {
    expect(placeOf(viaLibrary(taken), project)).toBe("src/through.mjs:3");
  });

  it("is nothing when no frame is the project's: outside it, in Node, or in this package", () => {
    expect(placeOf(outside(taken), project)).toBeUndefined();
    // The repository holds this package, and its frames — this test's — are still not the project's.
    const repository = fileURLToPath(new URL("../../..", import.meta.url));
    expect(placeOf(taken(), repository)).toBeUndefined();
  });

  it("is nothing when the stack cannot be read, and reading it throws nothing", () => {
    expect(placeOf({}, project)).toBeUndefined();
    expect(placeOf({ stack: ["an", "application's", "prepareStackTrace"] }, project)).toBeUndefined();
    const throwing = {
      get stack(): unknown {
        throw new Error("an application's prepareStackTrace that throws");
      },
    };
    expect(placeOf(throwing, project)).toBeUndefined();
  });
});

/** A file of the test's own for the places, and the register that writes it. */
async function register(): Promise<{ sites: CallSites; file: string; warned: string[] }> {
  const dir = await mkdtemp(join(root, "run-"));
  const file = join(dir, "change.sites.jsonl");
  const warned: string[] = [];
  return { sites: new CallSites({ file, project, log: { ...quiet, warn: (m) => warned.push(m) } }), file, warned };
}

/** What the file holds, line by line. */
async function written(file: string): Promise<unknown[][]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { sites: unknown[] }).sites);
}

/** One query of the request `ctx`, made where `site` was taken. */
function ran(ctx: RequestContext, sites: CallSites, text: string, hash: string): void {
  recordOperationIn(ctx, {
    kind: "query",
    fingerprint: { hash, text },
    startedAt: 0,
    endedAt: 1,
    site: sites.capture(text),
  });
}

describe("the places of a run", () => {
  it("takes no stack outside a request: a query at start-up belongs to no route", async () => {
    const { sites } = await register();
    expect(apart(() => sites.capture("select 1"))).toBeUndefined();
  });

  it("names where a request ran an operation, under its route, and writes it once", async () => {
    const { sites, file } = await register();
    apart(() => {
      const ctx = enterRequest();
      caller.loop(5, () => ran(ctx, sites, "select ?", "a1"));
      sites.finished(ctx, "GET /orders/:id");
    });
    await sites.write();
    await sites.write();
    expect(await written(file)).toEqual([
      [{ route: "GET /orders/:id", kind: "query", hash: "a1", at: `src/caller.mjs:${LOOP_LINE}` }],
    ]);
  });

  it("takes the stack of the first calls of each text in a request, and of no more calls in all than its cap", async () => {
    const { sites } = await register();
    apart(() => {
      enterRequest();
      const same = caller.loop(10, () => sites.capture("select ?"));
      expect(same.filter((site) => site !== undefined)).toHaveLength(3);
      const distinct = Array.from({ length: 200 }, (_, i) => sites.capture(`select ${i}`));
      expect(distinct.filter((site) => site !== undefined)).toHaveLength(128 - 3);
    });
    // A new request starts its own samples.
    apart(() => {
      enterRequest();
      expect(sites.capture("select ?")).toBeDefined();
    });
  });

  it("charges what runs inside a call already taken to that call, as a pool's query runs later from a connection", async () => {
    const { sites } = await register();
    apart(() => {
      enterRequest();
      const outer = sites.capture("select ?");
      expect(outer).toBeDefined();
      expect(sites.within(outer, () => sites.capture("select ?"))).toBe(outer);
      // A call that was not sampled leaves what runs inside it unsampled too, rather than taking the pool's stack.
      expect(sites.within(undefined, () => sites.capture("select 2"))).toBeUndefined();
    });
  });

  it(`keeps ${SITES_PER_OPERATION} places for each operation of a route, across its requests`, async () => {
    const { sites, file } = await register();
    for (const pair of [
      [caller.one, caller.two],
      [caller.three, caller.four],
    ] as const) {
      apart(() => {
        const ctx = enterRequest();
        for (const through of pair) through(() => ran(ctx, sites, "select ?", "b2"));
        sites.finished(ctx, "GET /reports");
      });
    }
    await sites.write();
    const places = (await written(file)).flat().map((site) => (site as { at: string }).at);
    expect(places).toEqual(
      ["export const one", "export const two", "export const three"].map(
        (needle) => `src/caller.mjs:${lineOf(CALLER, needle)}`,
      ),
    );
  });

  it("writes the text of an operation that is not a query, which names its host, and never a query's", async () => {
    const { sites, file } = await register();
    apart(() => {
      const ctx = enterRequest();
      caller.call(() => {
        recordOperationIn(ctx, {
          kind: "call",
          fingerprint: { hash: "c3", text: "GET 127.0.0.1:4100" },
          startedAt: 0,
          endedAt: 1,
          site: sites.capture("GET 127.0.0.1:4100"),
        });
        ran(ctx, sites, "select id from users where email = ?", "d4");
      });
      sites.finished(ctx, "POST /checkout");
    });
    await sites.write();
    expect((await written(file)).flat()).toEqual([
      {
        route: "POST /checkout",
        kind: "call",
        hash: "c3",
        text: "GET 127.0.0.1:4100",
        at: `src/caller.mjs:${CALL_LINE}`,
      },
      { route: "POST /checkout", kind: "query", hash: "d4", at: `src/caller.mjs:${CALL_LINE}` },
    ]);
  });

  it("says once that its file cannot be written, and throws nothing", async () => {
    const { warned } = await register();
    const sites = new CallSites({
      file: join(root, "no-such-directory", "sites.jsonl"),
      project,
      log: { ...quiet, warn: (m) => warned.push(m) },
    });
    for (const route of ["GET /a", "GET /b"]) {
      apart(() => {
        const ctx = enterRequest();
        caller.call(() => ran(ctx, sites, "select ?", "e5"));
        sites.finished(ctx, route);
      });
      await sites.write();
      sites.writeOnExit();
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("could not write the places");
  });
});

/**
 * `pg`'s shape, as far as the observer touches it: a client's `query`, in both forms, and a pool whose `query` asks a
 * connection of itself and runs the query on it later, from a callback of its own, as `pg-pool`'s does.
 */
const FAKE_PG = `class Client {
  query(text, ...rest) {
    const cb = rest.find((arg) => typeof arg === "function");
    const result = { rows: [{ text }] };
    if (cb !== undefined) {
      setImmediate(() => cb(null, result));
      return undefined;
    }
    return new Promise((resolve) => setImmediate(() => resolve(result)));
  }
}
class Pool {
  connect(cb) {
    const client = new Client();
    if (cb === undefined) return Promise.resolve(client);
    process.nextTick(() => cb(undefined, client, () => {}));
    return undefined;
  }
  query(text, values) {
    return new Promise((resolve, reject) => {
      this.connect((err, client) => {
        if (err) return reject(err);
        client.query(text, values, (failure, result) => (failure ? reject(failure) : resolve(result)));
      });
    });
  }
}
module.exports = { Client, Pool };
`;

/** Writes the stand-in for `pg` into the `node_modules` of `dir`. */
async function withFakePg(dir: string): Promise<void> {
  await mkdir(join(dir, "node_modules", "pg"), { recursive: true });
  await writeFile(
    join(dir, "node_modules", "pg", "package.json"),
    '{"name":"pg","version":"8.99.0","main":"index.js"}',
  );
  await writeFile(join(dir, "node_modules", "pg", "index.js"), FAKE_PG);
}

interface FakeClient {
  query(text: string, ...rest: unknown[]): unknown;
}
interface FakePg {
  Client: new () => FakeClient;
  Pool: new () => { query(text: string, values?: unknown[]): Promise<unknown> };
}

describe("pg's queries, under check", () => {
  it("name the application's call in each form, and through the pool's own query", async () => {
    await withFakePg(project);
    const pg = createRequire(join(project, "index.js"))("pg") as FakePg;
    const { sites, file } = await register();
    instrumentPg({
      log: quiet,
      internalError: (err) => expect.fail(String(err)),
      fingerprints: new FingerprintCache(),
      sites,
      moduleImpl: pg,
    });
    const pool = new pg.Pool();
    const client = new pg.Client();
    await apart(async () => {
      const ctx = enterRequest();
      await caller.one(() => client.query("select 1 as promised"));
      await caller.two(() => new Promise((resolve) => client.query("select 2 as called", resolve)));
      await caller.three(() => pool.query("select 3 as pooled", [3]));
      sites.finished(ctx, "GET /x");
    });
    await sites.write();
    const places = (await written(file)).flat().map((site) => (site as { at: string }).at);
    expect(places.sort()).toEqual(
      ["export const one", "export const two", "export const three"].map(
        (needle) => `src/caller.mjs:${lineOf(CALLER, needle)}`,
      ),
    );
  });
});

/** Express, which a project of the test links into its `node_modules`. */
const EXPRESS_DIR = dirname(createRequire(import.meta.url).resolve("express/package.json"));

describe("a process that runs under check", () => {
  // The application as a run of `check` starts it: the instrumentation loaded through `--import`, a file for the
  // batches and one for the places. `pg` is a stand-in with pg's shape, so no database is needed to see where the
  // places go and where they do not.
  const ORDERS = `export async function orderWithLines(pool, id) {
  const lines = [];
  for (let line = 0; line < 4; line += 1) {
    lines.push(await pool.query("select $1::int + $2::int as line", [id, line]));
  }
  return lines;
}
`;
  const APP = `import express from "express";
import pg from "pg";
import { orderWithLines } from "./src/orders.mjs";

const pool = new pg.Pool();
const app = express();
app.get("/orders/:id", async (req, res) => res.json(await orderWithLines(pool, Number(req.params.id))));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
for (const id of [1, 2, 3]) await fetch(\`http://127.0.0.1:\${server.address().port}/orders/\${id}\`);
server.close();
`;
  let batches: string;
  let places: string;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(root, "app-"));
    await mkdir(join(dir, "src"));
    await withFakePg(dir);
    await writeFile(join(dir, "app.mjs"), APP);
    await writeFile(join(dir, "src", "orders.mjs"), ORDERS);
    await symlink(EXPRESS_DIR, join(dir, "node_modules", "express"), "dir");
    const inspect = join(dir, "run.jsonl");
    const sitesFile = join(dir, "run.sites.jsonl");
    const child = spawn(process.execPath, [`--import=${REGISTER_URL}`, "app.mjs"], {
      cwd: dir,
      env: cleanEnv({
        DOWNTRACE_INSPECT: inspect,
        DOWNTRACE_CHECK_ROUTES: join(dir, "run.routes.jsonl"),
        DOWNTRACE_CHECK_PROJECT: dir,
        DOWNTRACE_CHECK_SITES: sitesFile,
        DOWNTRACE_INTERVAL_MS: "1000",
        DOWNTRACE_PROFILE_MS: "1000",
      }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code, stderr).toBe(0);
    batches = await readFile(inspect, "utf8");
    places = await readFile(sitesFile, "utf8");
  }, 60_000);

  it("writes where the loop runs the query, beside the batches", () => {
    const line = lineOf(ORDERS, "pool.query");
    expect(
      places
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { sites: [{ route: "GET /orders/:id", kind: "query", hash: expect.any(String), at: `src/orders.mjs:${line}` }] },
    ]);
  });

  it("sends none of it: the batches, which are what would travel, hold no place and no path of the machine", () => {
    // The batches did see the query, so its absence below is not a run that observed nothing.
    expect(batches).toContain('"route":"/orders/:id","operations":[{"kind":"query"');
    expect(batches).not.toContain("orders.mjs");
    expect(batches).not.toContain('"sites"');
    expect(batches).not.toContain(dir);
  });
});
