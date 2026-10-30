import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apart, enterRequest, type RequestContext } from "../src/context.ts";
import { armPrisma, LAST_LOOK } from "../src/instrument/prisma.ts";
import type { Logger } from "../src/log.ts";
import { CLIENT_REQUEST, generatePrisma, type PrismaLayout } from "./support/prisma-client.ts";

/**
 * Where the observer finds a generated client (ADR 0241): resolved from the application's root at start-up, and patched
 * at the first request at which the application has loaded it. In a process of its own, because the module cache is
 * the question: once a client of the workspace's runtime is loaded, every arm finds it loaded.
 *
 * The runner puts the package store on `NODE_PATH`, so `@prisma/client` resolves from anywhere in this process, and the
 * question of an application that has none could not be asked. Node reads the variable once at start, so it is read
 * again here, empty: the runner starts one process per file.
 */
beforeAll(() => {
  process.env.NODE_PATH = "";
  (Module as unknown as { _initPaths: () => void })._initPaths();
});

const require = createRequire(import.meta.url);
const quiet: Logger = { warn: () => {}, debug: () => {} };
const handed: unknown[] = [];
const deps = {
  log: quiet,
  internalError: (err: unknown): void => {
    handed.push(err);
  },
};
afterEach(() => {
  expect(handed.splice(0), "the instrumentation failed while recording").toEqual([]);
});

async function inRequest(fn: () => Promise<void>): Promise<RequestContext> {
  return apart(async () => {
    const ctx = enterRequest();
    await fn();
    return ctx;
  });
}

const operationsOf = (ctx: RequestContext) =>
  [...(ctx.operations?.values() ?? [])].filter((o) => o.kind === "query").map((o) => [o.text, o.count]);

describe("arming Prisma from the application's root", () => {
  // The module cache is the process's, and a client loaded by one test is in it for every test after: the one about
  // what is not loaded yet goes first.
  const made: string[] = [];
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  /** A project with a client generated into it and not loaded, and the arm of an application there. */
  async function generated(layout: PrismaLayout) {
    // By its real path, which is the module cache's: the temporary directory may be a link (macOS's is).
    const dir = await realpath(await mkdtemp(join(tmpdir(), `dt-prisma-arm-${layout}-`)));
    made.push(dir);
    await generatePrisma(dir, layout, join(dir, "app.db"));
    await writeFile(join(dir, "app.js"), "");
    const armed = armPrisma({ ...deps, from: join(dir, "app.js") });
    expect(armed.state).toBe("on");
    // biome-ignore lint/suspicious/noExplicitAny: the generated client's types are the project's, not the test's.
    const load = () => createRequire(join(dir, "app.js"))(CLIENT_REQUEST[layout]) as any;
    return { dir, armed, load };
  }

  async function counted(PrismaClient: new () => { user: { count(): Promise<number> }; $disconnect(): Promise<void> }) {
    const prisma = new PrismaClient();
    try {
      const ctx = await inRequest(async () => {
        await prisma.user.count();
      });
      expect(operationsOf(ctx)).toEqual([["count User", 1]]);
    } finally {
      await prisma.$disconnect();
    }
  }

  it("looks in the module cache at the requests that are powers of two, finds a client loaded late, and stops", async () => {
    const { armed, load } = await generated("output");
    // Nothing loaded anywhere: looked at eleven times in the first 1024 requests, and no more.
    const never = armPrisma({ ...deps, from: join(made[0] as string, "app.js") });
    const settled = Array.from({ length: LAST_LOOK }, () => never.attach());
    expect(settled.slice(0, -1).every((done) => !done)).toBe(true);
    expect(settled.at(-1)).toBe(true);

    expect([armed.attach(), armed.attach()]).toEqual([false, false]);
    // Loaded lazily, after the second request: the third does not look, and the fourth finds it.
    const { PrismaClient } = load();
    expect([armed.attach(), armed.attach()]).toEqual([false, true]);
    await counted(PrismaClient);
  }, 60_000);

  it("finds the client generated in node_modules, which requires @prisma/client's runtime", async () => {
    const { armed, load } = await generated("default");
    const { PrismaClient } = load();
    // What the ES module loader puts in the cache beside them, an application's `.mjs`, has no `children`.
    const esm = join(made.at(-1) as string, "app.mjs");
    require.cache[esm] = { id: esm, exports: {} } as NodeJS.Module;
    try {
      expect(armed.attach()).toBe(true);
    } finally {
      delete require.cache[esm];
    }
    await counted(PrismaClient);
  }, 60_000);

  it("finds a client generated into the project, whose runtime is a copy of its own beside it", async () => {
    // Prisma 6 copies its runtime into the output directory, and the client requires that copy, never
    // `@prisma/client`'s: what the module cache has is `generated/prisma/runtime/library.js`.
    const { dir, armed, load } = await generated("output");
    const { PrismaClient } = load();
    expect(Object.keys(require.cache)).toContain(join(dir, "generated", "prisma", "runtime", "library.js"));
    expect(armed.attach()).toBe(true);
    await counted(PrismaClient);
  }, 60_000);

  it("is unavailable where @prisma/client does not resolve, and has nothing to attach", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dt-prisma-none-"));
    made.push(dir);
    expect(() => createRequire(join(dir, "app.js")).resolve("@prisma/client")).toThrow();
    const armed = armPrisma({ ...deps, from: join(dir, "app.js") });
    expect(armed.state).toBe("unavailable");
    expect(armed.attach()).toBe(true);
  });
});
