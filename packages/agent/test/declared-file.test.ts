import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createDeclaredRoutes } from "../src/declared.ts";
import type { Logger } from "../src/log.ts";
import { armMountRecording } from "../src/mounts.ts";

/**
 * The file `downtrace check` reads the declared routes of a run from (ESC-18): one JSON line per write, each
 * with the routes not written before, from every Express application that answered a request in the process.
 */

armMountRecording(express.Router.prototype) || armMountRecording(express.Router);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function room(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "declared-file-"));
  dirs.push(dir);
  return dir;
}

const quiet: Logger = { warn: () => {}, debug: () => {} };
const everything = (): boolean => true;

async function lines(file: string): Promise<string[][]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { routes: string[] }).routes.sort());
}

function application() {
  const app = express();
  app.get("/health", (_req, res) => res.send("ok"));
  app.post("/orders", (_req, res) => res.send("order"));
  return app;
}

describe("createDeclaredRoutes", () => {
  it("is nothing without a file: outside check the routes are never walked", () => {
    expect(createDeclaredRoutes({ file: undefined, log: quiet, observed: everything })).toBeUndefined();
  });

  it("writes the routes of the applications that answered a request, once each", async () => {
    const file = join(await room(), "run.routes.jsonl");
    const declared = createDeclaredRoutes({ file, log: quiet, observed: everything });
    const app = application();
    declared?.answered({ app });
    declared?.answered({ app });
    await declared?.write();
    await declared?.write();
    expect(await lines(file)).toEqual([["GET /health", "POST /orders"]]);
  });

  it("writes a route registered after the first write on the next one, and only it", async () => {
    const file = join(await room(), "run.routes.jsonl");
    const declared = createDeclaredRoutes({ file, log: quiet, observed: everything });
    const app = application();
    declared?.answered({ app });
    await declared?.write();
    app.get("/late", (_req, res) => res.send("late"));
    declared?.writeOnExit();
    expect(await lines(file)).toEqual([["GET /health", "POST /orders"], ["GET /late"]]);
  });

  it("leaves out a route the operator excluded: excluded is not observed (ADR 0101)", async () => {
    const file = join(await room(), "run.routes.jsonl");
    const declared = createDeclaredRoutes({ file, log: quiet, observed: (route) => route !== "/health" });
    declared?.answered({ app: application() });
    await declared?.write();
    expect(await lines(file)).toEqual([["POST /orders"]]);
  });

  it("writes nothing for a request no Express application answered, and makes no file for it", async () => {
    const file = join(await room(), "run.routes.jsonl");
    const declared = createDeclaredRoutes({ file, log: quiet, observed: everything });
    declared?.answered({ url: "/plain" });
    declared?.answered({ app: () => {} });
    await declared?.write();
    declared?.writeOnExit();
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("says once that the file cannot be written, and never throws toward the application (invariant 2)", async () => {
    const file = join(await room(), "missing", "deeper", "run.routes.jsonl");
    const warnings: string[] = [];
    const log: Logger = { warn: (message) => warnings.push(message), debug: () => {} };
    const declared = createDeclaredRoutes({ file, log, observed: everything });
    const app = application();
    declared?.answered({ app });
    await expect(declared?.write()).resolves.toBeUndefined();
    app.get("/more", (_req, res) => res.send("more"));
    expect(() => declared?.writeOnExit()).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });
});
