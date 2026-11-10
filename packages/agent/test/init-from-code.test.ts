import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DT-133: the instrumentation started from the application's own code. An instrument file calls `init({ dsn })`, and
 * the application loads it before anything else: `node --import ./instrument.mjs` for ES modules (RF-102). Without a
 * DSN it stays inert (RF-104); a process has one instrumentation (RF-105).
 *
 * In real processes, because what is under test is a process's start: what is loaded first, and what is left running.
 */

const agentDir = fileURLToPath(new URL("..", import.meta.url));
const index = path.join(agentDir, "src", "index.ts");
const register = path.join(agentDir, "src", "register.ts");

/** The parent's environment, minus the instrumentation's own variables and `NODE_PATH`, plus what a case sets. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DOWNTRACE_") || key === "NODE_PATH") delete env[key];
  return { ...env, ...extra };
}

function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = agentDir,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const lines = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("[downtrace]"));

/** A cloud that takes every batch, and keeps where it was sent, with what credentials, and what it carried. */
interface Received {
  url: string;
  authorization: string | undefined;
  body: { intervals?: Array<{ endpoints?: Array<{ method: string; route: string }> }> };
}

async function sink(): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        received.push({ url: req.url ?? "", authorization: req.headers.authorization, body: JSON.parse(body) });
      } catch {
        received.push({ url: req.url ?? "", authorization: req.headers.authorization, body: {} });
      }
      res.writeHead(202, { "content-type": "application/json" }).end('{"accepted":1,"inserted":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The application: an ES module that serves one request, makes it to itself, and leaves, handing over what the
 * instrumentation holds on the way out.
 */
const APP = `
import http from "node:http";
import { shutdown } from ${JSON.stringify(index)};
const server = http.createServer((req, res) => res.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
await (await fetch("http://127.0.0.1:" + port + "/orders/42")).text();
server.close();
await shutdown();
`;

/** What a child prints when it has run: whether anything listens to the requests it serves and makes. */
const PROBE = `import dc from "node:diagnostics_channel";
console.log(JSON.stringify({ attached: dc.hasSubscribers("http.server.request.start") || dc.hasSubscribers("http.client.request.start") }));`;

const routesOf = (received: Received[]): string[] =>
  [
    ...new Set(
      received
        .flatMap((r) => r.body.intervals ?? [])
        .flatMap((i) => (i.endpoints ?? []).map((e) => `${e.method} ${e.route}`)),
    ),
  ].sort();

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dt-init-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes an instrument file, the user's own, which loads the package from its source here. */
async function instrumentFile(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `import { init } from ${JSON.stringify(index)};\n${body}\n`);
  return file;
}

describe("an ES module application started with --import ./instrument.mjs (RF-102)", () => {
  it("is observed as with the register entry, and its token travels in the header, never in the URL", async () => {
    const cloud = await sink();
    try {
      const dsn = `http://dt_fromcode@127.0.0.1:${cloud.port}`;
      const instrument = await instrumentFile(
        "instrument.mjs",
        `init({ dsn: ${JSON.stringify(dsn)}, version: "v1" });`,
      );
      const fromCode = await runNode(["--import", instrument, "--input-type=module", "-e", APP], childEnv());
      expect(fromCode.code, fromCode.stderr).toBe(0);
      const byCode = cloud.received.splice(0);

      const fromRegister = await runNode(
        ["--import", register, "--input-type=module", "-e", APP],
        childEnv({
          DOWNTRACE_TOKEN: "dt_fromenv",
          DOWNTRACE_URL: `http://127.0.0.1:${cloud.port}`,
          DOWNTRACE_VERSION: "v1",
        }),
      );
      expect(fromRegister.code, fromRegister.stderr).toBe(0);
      const byRegister = cloud.received.splice(0);

      expect(routesOf(byCode)).toEqual(["GET /orders/:id"]);
      expect(routesOf(byCode)).toEqual(routesOf(byRegister));
      expect(byCode.map((r) => r.authorization)).toEqual(byCode.map(() => "Bearer dt_fromcode"));
      for (const r of byCode) expect(r.url).not.toContain("dt_fromcode");
      expect(fromCode.stderr).not.toContain("dt_fromcode");
    } finally {
      await cloud.close();
    }
  });
});

describe("init() with no DSN (RF-104)", () => {
  it("warns once, and nothing else: nothing listens and nothing is sent", async () => {
    const instrument = await instrumentFile("inert.mjs", "init({});");
    const { code, stdout, stderr } = await runNode(
      ["--import", instrument, "--input-type=module", "-e", PROBE],
      childEnv(),
    );
    expect(code, stderr).toBe(0);
    expect(lines(stderr)).toEqual([
      "[downtrace] instrumentation disabled: init() was given no dsn, and DOWNTRACE_DSN is not set, nor DOWNTRACE_TOKEN and DOWNTRACE_URL",
    ]);
    expect(JSON.parse(stdout)).toEqual({ attached: false });
  });

  it("with a malformed one, says what is wrong without echoing the token, and stays inert", async () => {
    const instrument = await instrumentFile("malformed.mjs", `init({ dsn: "dt_SECRETVALUE@downtrace.example.com" });`);
    const { code, stdout, stderr } = await runNode(
      ["--import", instrument, "--input-type=module", "-e", PROBE],
      childEnv({ DOWNTRACE_DEBUG: "1" }),
    );
    expect(code, stderr).toBe(0);
    expect(lines(stderr)).toEqual([
      expect.stringMatching(/^\[downtrace\] instrumentation disabled: init\(\)'s dsn is not a URL/),
    ]);
    expect(stderr).not.toContain("SECRETVALUE");
    expect(JSON.parse(stdout)).toEqual({ attached: false });
  });

  it("never throws into the application, whatever it is handed", async () => {
    const instrument = await instrumentFile(
      "hostile.mjs",
      `init({ get dsn() { throw new Error("a getter of the application's"); } });\nconsole.log("went on");`,
    );
    const { code, stdout, stderr } = await runNode(["--import", instrument, "-e", ""], childEnv());
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("went on");
    expect(lines(stderr)).toEqual([
      expect.stringMatching(/^\[downtrace\] instrumentation disabled: init\(\) failed: /),
    ]);
  });
});

describe("one instrumentation per process (RF-105)", () => {
  const started = (stderr: string): string[] => lines(stderr).filter((line) => line.startsWith("[downtrace] started:"));
  const ALREADY =
    "[downtrace] init() starts nothing: this process already runs the instrumentation, and keeps its settings";

  it("starts one when init() is called twice, and the second call says so", async () => {
    const dsn = JSON.stringify("http://dt_a@127.0.0.1:9");
    const instrument = await instrumentFile(
      "twice.mjs",
      `init({ dsn: ${dsn}, debug: true, version: "v1" });\ninit({ dsn: ${dsn}, debug: true, version: "v1" });`,
    );
    const { code, stderr } = await runNode(["--import", instrument, "-e", ""], childEnv());
    expect(code, stderr).toBe(0);
    expect(started(stderr)).toHaveLength(1);
    expect(lines(stderr).filter((line) => line === ALREADY)).toHaveLength(1);
  });

  it("starts nothing new when the register entry already started one", async () => {
    const instrument = await instrumentFile(
      "after-register.mjs",
      `init({ dsn: "http://dt_code@127.0.0.1:9", debug: true });`,
    );
    const { code, stderr } = await runNode(
      ["--import", register, "--import", instrument, "-e", ""],
      childEnv({
        DOWNTRACE_TOKEN: "dt_env",
        DOWNTRACE_URL: "http://127.0.0.1:9",
        DOWNTRACE_DEBUG: "1",
        DOWNTRACE_VERSION: "v1",
      }),
    );
    expect(code, stderr).toBe(0);
    expect(started(stderr)).toHaveLength(1);
    expect(lines(stderr).filter((line) => line === ALREADY)).toHaveLength(1);
  });

  it("starts when the register entry was loaded and stayed inert: an inert entry is no instrumentation", async () => {
    const instrument = await instrumentFile(
      "after-inert.mjs",
      `init({ dsn: "http://dt_code@127.0.0.1:9", debug: true, version: "v1" });`,
    );
    const { code, stderr } = await runNode(["--import", register, "--import", instrument, "-e", ""], childEnv());
    expect(code, stderr).toBe(0);
    expect(started(stderr)).toHaveLength(1);
    expect(stderr).not.toContain(ALREADY);
  });
});

describe("two copies of the package in one process (RF-105)", () => {
  it("share the instrumentation one of them started: the other's init() sees it, and its shutdown() drains it", async () => {
    // Two URLs of one file are two modules, as the copy `downtrace check` loads and the application's own are.
    const registered = pathToFileURL(path.join(agentDir, "src", "registered.ts")).href;
    const script = `
      import { remember } from ${JSON.stringify(`${registered}?copy=check`)};
      import { registered, shutdown } from ${JSON.stringify(`${registered}?copy=application`)};
      let stopped = 0;
      const agent = { stop: async () => { stopped += 1; } };
      remember(agent);
      const seen = registered() === agent;
      await shutdown();
      console.log(JSON.stringify({ seen, stopped, after: registered() === undefined }));
    `;
    const { code, stdout, stderr } = await runNode(["--input-type=module", "-e", script], childEnv());
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ seen: true, stopped: 1, after: true });
  });
});

describe("a late init() (RF-105)", () => {
  /** An application that loads express, and maybe mounts a router, and only then calls init(): the late case. */
  const late = (before: string) => `
    import express from "express";
    import { init } from ${JSON.stringify(index)};
    ${before}
    init({ inspect: ${JSON.stringify(path.join(dir, "late.jsonl"))}, version: "v1" });
  `;

  it("names express, loaded before it, and what a router mounted before it loses", async () => {
    const { code, stderr } = await runNode(["--input-type=module", "-e", late("")], childEnv());
    expect(code, stderr).toBe(0);
    expect(lines(stderr)).toEqual([
      "[downtrace] init() ran after the application loaded express: a router mounted before init() is named without its mount path. Load the instrument file before anything else",
    ]);
  });

  it("says nothing when it runs first", async () => {
    const script = `
      import { init } from ${JSON.stringify(index)};
      init({ inspect: ${JSON.stringify(path.join(dir, "late.jsonl"))}, version: "v1" });
      await import("express");
    `;
    const { code, stderr } = await runNode(["--input-type=module", "-e", script], childEnv());
    expect(code, stderr).toBe(0);
    expect(lines(stderr)).toEqual([]);
  });

  /**
   * Express loaded, its application built and a router mounted, and the instrumentation started before or after the
   * mount: what the lab found a late `init()` loses, and what it does not.
   */
  async function mountedRoutes(order: "init, then mount" | "mount, then init"): Promise<string[]> {
    const file = path.join(dir, `mounted-${order.replaceAll(/\W+/g, "-")}.jsonl`);
    const start = `init({ inspect: ${JSON.stringify(file)}, version: "v1" });`;
    const script = `
      import express from "express";
      import { init, shutdown } from ${JSON.stringify(index)};
      ${order === "init, then mount" ? start : ""}
      const app = express();
      const router = express.Router();
      router.get("/users/:id", (req, res) => res.send("ok"));
      app.use("/api", router);
      ${order === "mount, then init" ? start : ""}
      const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      await (await fetch("http://127.0.0.1:" + server.address().port + "/api/users/42")).text();
      server.close();
      await shutdown();
    `;
    const { code, stderr } = await runNode(["--input-type=module", "-e", script], childEnv());
    expect(code, stderr).toBe(0);
    const batches = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
    const routes = batches.flatMap((line) => {
      const batch = JSON.parse(line) as Received["body"];
      return (batch.intervals ?? []).flatMap((i) => (i.endpoints ?? []).map((e) => `${e.method} ${e.route}`));
    });
    return [...new Set(routes)];
  }

  it("observes express loaded before it whole, when the routers are mounted after", async () => {
    expect(await mountedRoutes("init, then mount")).toEqual(["GET /api/users/:id"]);
  });

  it("loses the mount path of a router mounted before it, which is what its warning says", async () => {
    expect(await mountedRoutes("mount, then init")).toEqual(["GET /:param/users/:id"]);
  });
});
