import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { apart, enterRequest, type RequestContext } from "../src/context.ts";
import { armPrisma } from "../src/instrument/prisma.ts";
import type { Logger } from "../src/log.ts";
import { CLIENT_REQUEST, generatePrisma } from "./support/prisma-client.ts";

/**
 * Under `check` (ADR 0243), Prisma's runtime is wrapped as Node loads it, so that every class its `getPrismaClient` makes
 * is patched where it is made: what reaches a client Vitest runs from the project's own directory, which never enters
 * the module cache and leaves only its runtime to Node. In a process of its own: the wrap is the process's.
 */

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

describe("wrapping Prisma's runtime as it loads, under check", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  it("patches the class a client's getPrismaClient makes, with no request to attach at", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "dt-prisma-early-")));
    made.push(dir);
    await generatePrisma(dir, "output", join(dir, "app.db"));
    await writeFile(join(dir, "app.js"), "");
    const armed = armPrisma({ ...deps, from: join(dir, "app.js"), early: true });
    expect(armed.state).toBe("on");
    // biome-ignore lint/suspicious/noExplicitAny: the generated client's types are the project's, not the test's.
    const { PrismaClient } = createRequire(join(dir, "app.js"))(CLIENT_REQUEST.output) as any;
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

  it("hands the runtime over whole: the client gets every export it had", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "dt-prisma-early-")));
    made.push(dir);
    await generatePrisma(dir, "output", join(dir, "app.db"));
    const runtime = createRequire(join(dir, "app.js"))("./generated/prisma/runtime/library.js") as Record<
      string,
      unknown
    >;
    const keys = Object.keys(runtime);
    expect(keys).toContain("getPrismaClient");
    expect(keys).toContain("PrismaClientKnownRequestError");
    for (const key of keys) expect(runtime[key], key).toBeDefined();
  }, 60_000);
});
