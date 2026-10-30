import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { apart, currentContext, dependencyKey, enterRequest, type RequestContext } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import { patchPostgresJs } from "../src/instrument/postgresjs.ts";
import type { Logger } from "../src/log.ts";

/**
 * postgres.js's `Query`, the real class of each of its two copies, driven by a handler of the test's that does what
 * the driver's connection does: it builds the text, and settles the query later, from outside the request that
 * awaited it — the driver settles it from the connection's socket. The behaviour against a real Postgres, through
 * the start, is `postgresjs.integration.test.ts`'s.
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };
const handed: unknown[] = [];
const internalError = (err: unknown): void => {
  handed.push(err);
};
afterEach(() => {
  expect(handed.splice(0), "the instrumentation failed while recording").toEqual([]);
});

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(require.resolve("postgres")), "..", "..");
const COPIES = [
  ["the ESM copy", () => import(pathToFileURL(path.join(root, "src", "query.js")).href)],
  ["the CommonJS copy", async () => require(path.join(root, "cjs", "src", "query.js"))],
] as const;

type QueryClass = new (
  strings: readonly string[],
  args: unknown[],
  handler: (query: Driven) => void,
  canceller?: unknown,
) => Driven;

/** What the driver's connection reads and writes on a query. */
interface Driven extends Promise<unknown> {
  strings: readonly string[];
  args: unknown[];
  string?: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/** The queries handed to the "connection", waiting to be settled. */
let waiting: Driven[] = [];
const connection = (query: Driven): void => {
  waiting.push(query);
};

/** The connection's answer: builds each waiting query's text, as postgres.js does, and settles it outside any request. */
function answer(settle: (query: Driven) => void, { build = true } = {}): void {
  const queries = waiting;
  waiting = [];
  apart(() => {
    expect(currentContext()).toBeUndefined();
    for (const query of queries) {
      if (build) query.string = query.strings.reduce((text, part, i) => `${text}$${i}${part}`);
      settle(query);
    }
  });
}

/** Turns of the loop until the driver's `handle` has handed every query to the connection. */
async function handedToConnection(count: number): Promise<void> {
  for (let i = 0; i < 100 && waiting.length < count; i++) await new Promise((r) => setImmediate(r));
  expect(waiting).toHaveLength(count);
}

/** Runs `fn` as the handler of a request, in a context of its own, and returns what it recorded. */
async function inRequest(fn: () => Promise<void>): Promise<RequestContext> {
  return apart(async () => {
    const ctx = enterRequest();
    await fn();
    return ctx;
  });
}

const queriesOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => [o.text, o.errors]);

describe.each(COPIES)("postgres.js's Query, %s", (_name, load) => {
  let Query: QueryClass;
  const fingerprints = new FingerprintCache();
  const errors = new ErrorFingerprintCache();
  const sql = (strings: TemplateStringsArray, ...args: unknown[]) => new Query(strings, args, connection);

  beforeAll(async () => {
    const module = (await load()) as { Query: QueryClass };
    Query = module.Query;
    expect(patchPostgresJs(module, "test", { log: quiet, internalError, fingerprints, errors })).toBe(true);
  });

  it("counts a query against the request that awaited it, settled from outside it, with no value in its text", async () => {
    const ctx = await inRequest(async () => {
      const pending = sql`select * from users where id = ${"ana-zq"}`;
      const result = (async () => pending)();
      await handedToConnection(1);
      answer((q) => q.resolve([{ id: 1 }]));
      expect(await result).toEqual([{ id: 1 }]);
    });
    expect(ctx.work?.get(dependencyKey("postgres", ""))).toMatchObject({ calls: 1, errors: 0 });
    expect(queriesOf(ctx)).toEqual([["select * from users where id = ?", 0]]);
    expect(JSON.stringify([...(ctx.operations?.values() ?? [])])).not.toContain("ana-zq");
  });

  it("counts a query once however many times the application chains on it", async () => {
    const ctx = await inRequest(async () => {
      const query = sql`select 1`;
      const chained = Promise.all([query.then((x) => x), query.catch(() => 0), query.finally(() => {})]);
      await handedToConnection(1);
      answer((q) => q.resolve(["one"]));
      await chained;
    });
    expect(ctx.work?.get(dependencyKey("postgres", ""))?.calls).toBe(1);
  });

  it("counts a failure, signed, and the application sees the driver's error as it came", async () => {
    const thrown = Object.assign(new Error('relation "orders" does not exist'), { code: "42P01" });
    let seen: unknown;
    const ctx = await inRequest(async () => {
      const query = sql`select * from orders`;
      const failing = query.catch((err: unknown) => {
        seen = err;
      });
      await handedToConnection(1);
      answer((q) => q.reject(thrown));
      await failing;
    });
    expect(seen).toBe(thrown);
    expect(ctx.work?.get(dependencyKey("postgres", ""))).toMatchObject({ calls: 1, errors: 1 });
    expect(queriesOf(ctx)).toEqual([["select * from orders", 1]]);
    expect([...(ctx.operations?.values() ?? [])].some((o) => o.kind === "error")).toBe(true);
  });

  it("reads the template the application wrote when the query failed before it reached a connection", async () => {
    const ctx = await inRequest(async () => {
      const query = sql`update accounts set balance = ${100} where id = ${"ana-zq"}`;
      const failing = query.catch(() => {});
      await handedToConnection(1);
      answer((q) => q.reject(new Error("write CONNECTION_CLOSED")), { build: false });
      await failing;
    });
    expect(queriesOf(ctx)).toEqual([["update accounts set balance = ? where id = ?", 1]]);
  });

  it("records nothing for a query outside a request, and the query works", async () => {
    const result = apart(async () => {
      const query = sql`select now()`;
      const settled = query.then((rows) => rows);
      await handedToConnection(1);
      answer((q) => q.resolve(["now"]));
      return settled;
    });
    expect(await result).toEqual(["now"]);
  });

  it("does not execute a query nobody awaited, as postgres.js does not", async () => {
    const ctx = await inRequest(async () => {
      sql`select 1`;
      await new Promise((r) => setImmediate(r));
    });
    expect(waiting).toEqual([]);
    expect(ctx.work).toBeUndefined();
  });

  it("is patched once however many times it is asked", async () => {
    expect(patchPostgresJs({ Query }, "test", { log: quiet, internalError, fingerprints, errors })).toBe(true);
    const ctx = await inRequest(async () => {
      const query = sql`select 2`;
      const settled = query.then((x) => x);
      await handedToConnection(1);
      answer((q) => q.resolve([]));
      await settled;
    });
    expect(ctx.work?.get(dependencyKey("postgres", ""))?.calls).toBe(1);
  });
});

describe("postgres.js's observer, when its own code fails", () => {
  /** The shape of postgres.js's `Query.prototype.handle`, on a class the test owns: patched afresh by each test. */
  function freshQueryClass() {
    return class FakeQuery {
      executed = false;
      strings: readonly string[] = ["select 1"];
      resolve: (x: unknown) => void = () => {};
      reject: (x: unknown) => void = () => {};
      handled = 0;
      handle(): void {
        if (!this.executed) {
          this.executed = true;
          this.handled += 1;
          this.string = "select 1";
          this.resolve(["one"]);
        }
      }
      string?: string;
    };
  }

  it("hands a fingerprint that throws to internalError, and the query is settled with its value", async () => {
    const FakeQuery = freshQueryClass();
    const fingerprints = {
      get: () => {
        throw new Error("boom");
      },
    } as unknown as FingerprintCache;
    expect(patchPostgresJs({ Query: FakeQuery }, "test", { log: quiet, internalError, fingerprints })).toBe(true);
    let value: unknown;
    const ctx = await inRequest(async () => {
      const query = new FakeQuery();
      query.resolve = (x) => {
        value = x;
      };
      query.handle();
      expect(query.handled).toBe(1);
    });
    expect(value).toEqual(["one"]);
    expect(handed.splice(0).map((e) => (e as Error).message)).toEqual(["boom"]);
    // The call was counted before the fingerprint failed; the operation was not.
    expect(ctx.work?.get(dependencyKey("postgres", ""))?.calls).toBe(1);
    expect(ctx.operations).toBeUndefined();
  });

  it("hands a query whose state throws to internalError, and the driver still runs it", async () => {
    const FakeQuery = freshQueryClass();
    expect(patchPostgresJs({ Query: FakeQuery }, "test", { log: quiet, internalError })).toBe(true);
    await inRequest(async () => {
      const query = new FakeQuery();
      let reads = 0;
      Object.defineProperty(query, "resolve", {
        get() {
          reads += 1;
          if (reads === 1) throw new Error("getter");
          return () => {};
        },
      });
      query.handle();
      expect(query.handled).toBe(1);
    });
    expect(handed.splice(0).map((e) => (e as Error).message)).toEqual(["getter"]);
  });

  it("refuses a module whose Query has no handle, and says so", () => {
    const said: string[] = [];
    const log: Logger = { warn: () => {}, debug: (line) => said.push(line) };
    expect(patchPostgresJs({ Query: class {} }, "test", { log, internalError })).toBe(false);
    expect(patchPostgresJs(undefined, "test", { log, internalError })).toBe(false);
    expect(said).toHaveLength(2);
  });
});

describe("postgres.js's start-up half", () => {
  it("is unavailable when the application's root has no postgres, and its attach settles at once", async () => {
    // The test process resolves `postgres` from anywhere (its own module paths and NODE_PATH), so the question is
    // asked of a process of its own, with no fallback paths and a root that holds no `node_modules`.
    const dir = await mkdtemp(path.join(tmpdir(), "downtrace-armpostgresjs-"));
    try {
      const src = fileURLToPath(new URL("../src/instrument/postgresjs.ts", import.meta.url));
      const script = `
        import { armPostgresJs } from ${JSON.stringify(src)};
        const armed = armPostgresJs({
          log: { warn: () => {}, debug: () => {} },
          internalError: (err) => { console.error(String(err)); process.exit(2); },
          from: process.argv[1],
        });
        console.log(armed.state);
        console.log(armed.attach());
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, path.join(dir, "app.js")], {
        env: { ...process.env, NODE_PATH: "" },
      });
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString();
      });
      const code = await new Promise<number>((resolve) => child.on("exit", resolve));
      expect(code, stdout).toBe(0);
      expect(stdout.trim().split("\n")).toEqual(["unavailable", "true"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds the project's postgres under check, where the runner's entry resolves none", async () => {
    // A runner kept where nothing of the project resolves, as pnpm's global virtual store keeps it, and the project
    // beside it (`resolutionBases`).
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "downtrace-armpostgresjs-bases-")));
    try {
      const project = path.join(dir, "project");
      const installed = path.resolve(path.dirname(createRequire(import.meta.url).resolve("postgres")), "..", "..");
      await mkdir(path.join(project, "node_modules"), { recursive: true });
      await symlink(installed, path.join(project, "node_modules", "postgres"), "dir");
      const src = fileURLToPath(new URL("../src/instrument/postgresjs.ts", import.meta.url));
      const script = `
        import { armPostgresJs } from ${JSON.stringify(src)};
        const deps = {
          log: { warn: () => {}, debug: () => {} },
          internalError: (err) => { console.error(String(err)); process.exit(2); },
        };
        console.log(armPostgresJs({ ...deps, from: process.argv[1] }).state);
        console.log(armPostgresJs({ ...deps, from: [process.argv[1], process.argv[2]] }).state);
      `;
      const runner = path.join(dir, "store", "vitest", "vitest.mjs");
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, runner, `${project}/`], {
        env: { ...process.env, NODE_PATH: "" },
      });
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString();
      });
      const code = await new Promise<number>((resolve) => child.on("exit", resolve));
      expect(code, stdout).toBe(0);
      expect(stdout.trim().split("\n"), "the runner alone, then the runner and the project").toEqual([
        "unavailable",
        "on",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
