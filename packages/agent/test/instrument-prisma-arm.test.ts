import { mkdtemp, rm, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apart, enterRequest, type RequestContext } from "../src/context.ts";
import { armPrisma } from "../src/instrument/prisma.ts";
import type { Logger } from "../src/log.ts";
import { CLIENT_REQUEST, generatePrisma } from "./support/prisma-client.ts";

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
  const made: string[] = [];
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  it("finds the client generated in node_modules once the application has loaded it, and not before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dt-prisma-arm-"));
    made.push(dir);
    await generatePrisma(dir, "default", join(dir, "app.db"));
    await writeFile(join(dir, "app.js"), "");
    const armed = armPrisma({ ...deps, from: join(dir, "app.js") });
    expect(armed.state).toBe("on");
    // Not loaded yet: nothing to patch, and the attach asks again at the next request.
    expect(armed.attach()).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: the generated client's types are the project's, not the test's.
    const { PrismaClient } = createRequire(join(dir, "app.js"))(CLIENT_REQUEST.default) as any;
    // What the ES module loader puts in the cache beside them, an application's `.mjs`, has no `children`.
    const esm = join(dir, "app.mjs");
    require.cache[esm] = { id: esm, exports: {} } as NodeJS.Module;
    try {
      expect(armed.attach()).toBe(true);
    } finally {
      delete require.cache[esm];
    }
    const prisma = new PrismaClient();
    try {
      const ctx = await inRequest(async () => {
        await prisma.user.count();
      });
      expect(operationsOf(ctx)).toEqual([["count User", 1]]);
    } finally {
      await prisma.$disconnect();
    }
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
