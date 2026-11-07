import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Agent, DRIVERLESS, driversFoundLine } from "../src/agent.ts";
import { type AgentConfig, INSTRUMENTS, type Instrument } from "../src/config.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { testConfig } from "./support/agent-config.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };

function config(instrument: Instrument[]): AgentConfig {
  return testConfig("http://sink.invalid", {
    environment: "test",
    version: "v",
    intervalMs: 60_000,
    instrument: new Set(instrument),
  });
}

/**
 * COB-01 by its name: «distingue instrumentación conectada de integración activa». Without this the cloud
 * cannot tell a service that does not use Redis from one that uses it and is not being watched — both look
 * like no rows at all (gh-180, invariant 14).
 */
describe("what the batch says it is observing", () => {
  it("says nothing until it has started, because it has not attached anything yet", () => {
    const agent = new Agent(config(["pg", "http", "redis", "runtime"]), { log: quiet });
    expect(agent.observers).toBeUndefined();
  });

  it("marks what was not asked for as off, which is not the same as not saying", () => {
    const agent = new Agent(config(["pg"]), { log: quiet });
    agent.start();
    try {
      expect(agent.observers).toMatchObject({ http: "off", redis: "off", runtime: "off" });
    } finally {
      void agent.stop();
    }
  });

  it("says off for every switch rather than going quiet when nothing is instrumented", () => {
    // `none` is an answer. Reporting it as absence would say «this sender did not tell us», which is what an
    // instrumentation older than 0.7.0 says, and the two must not read alike.
    const agent = new Agent(config([]), { log: quiet });
    agent.start();
    try {
      expect(agent.observers).toEqual(Object.fromEntries(INSTRUMENTS.map((name) => [name, "off"])));
    } finally {
      void agent.stop();
    }
  });

  it("attaches the ones that subscribe to a channel, which cannot fail", () => {
    const agent = new Agent(config(["http", "redis", "runtime"]), { log: quiet });
    agent.start();
    try {
      expect(agent.observers).toMatchObject({ http: "on", redis: "on", runtime: "on" });
    } finally {
      void agent.stop();
    }
  });

  it("says unavailable when the driver was asked for and could not be attached to", () => {
    // The case that opened the ticket: a monorepo or a bundle where `pg` is not resolvable from the
    // application's root, or a `pg` whose shape is not the one being patched. Both come back from
    // `instrumentPg` as no version, and today both fail into a `log.debug` nobody sees while the cloud
    // publishes «this service calls no database».
    const agent = new Agent(config(["pg"]), { log: quiet, pgModule: { notAClient: true } });
    agent.start();
    try {
      expect(agent.observers?.pg).toBe("unavailable");
    } finally {
      void agent.stop();
    }
  });

  it("says unavailable for MySQL too, which it could only log before protocol 0.11.0 (ADR 0240)", () => {
    const agent = new Agent(config(["mysql"]), { log: quiet, mysqlModule: { notAConnection: true } });
    agent.start();
    try {
      expect(agent.observers?.mysql).toBe("unavailable");
    } finally {
      void agent.stop();
    }
  });
});

/**
 * A driver the application declares and the instrumentation cannot resolve from its entry — a bundle, a monorepo that
 * keeps it elsewhere — against one the application does not use (RF-110, ADR 0240). The production path, in a child
 * process whose entry is the application's, as `register` starts it, with the batch read off its stderr.
 */
describe("a driver the application declares and none resolves", () => {
  const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
  const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));

  /** One request, and the way out, which writes the batch. */
  const SERVER = `
import http from "node:http";
import { pathToFileURL } from "node:url";
const app = http.createServer((req, res) => res.end("ok"));
await new Promise((r) => app.listen(0, "127.0.0.1", r));
await (await fetch(\`http://127.0.0.1:\${app.address().port}/orders\`)).arrayBuffer();
const { shutdown } = await import(pathToFileURL(process.argv[2]).href);
await shutdown();
app.closeAllConnections();
await new Promise((r) => app.close(r));
`;

  /** What the first batch of an application with this `package.json`, and no `node_modules`, says it observes. */
  async function observersOf(manifest: Record<string, unknown>): Promise<Record<string, string> | undefined> {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "downtrace-observers-")));
    try {
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", private: true, ...manifest }));
      await writeFile(path.join(dir, "server.mjs"), SERVER, "utf8");
      // The parent's environment without the agent's variables, and without the `NODE_PATH` the runner fills with
      // the package store: an application is never started with it, and from it every driver would resolve.
      const env: NodeJS.ProcessEnv = { ...process.env, DOWNTRACE_INSPECT: "stderr" };
      for (const key of ["DOWNTRACE_TOKEN", "DOWNTRACE_URL", "DOWNTRACE_INSTRUMENT", "DOWNTRACE_DEBUG", "NODE_PATH"]) {
        delete env[key];
      }
      const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", register, path.join(dir, "server.mjs"), index], { env });
        let err = "";
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("exit", (exit) => resolve({ code: exit, stderr: err }));
      });
      expect(code, `the child failed\n${stderr}`).toBe(0);
      const first = stderr.split("\n").find((line) => line.trimStart().startsWith("{"));
      expect(first, `no batch left\n${stderr}`).toBeDefined();
      return (JSON.parse(first ?? "{}") as { agent?: { observers?: Record<string, string> } }).agent?.observers;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // covers: RF-110
  it("says `unavailable`, as it says it of pg, when the application declares mysql2", async () => {
    const observers = await observersOf({ dependencies: { mysql2: "^3" } });
    expect(observers).toMatchObject({ mysql: "unavailable", pg: "unavailable", http: "on" });
  });

  // covers: RF-110
  it("says it of every MySQL driver the switch observes, and of what brings one", async () => {
    for (const name of ["mysql", "mariadb", "@mikro-orm/mysql"]) {
      expect((await observersOf({ devDependencies: { [name]: "^1" } }))?.mysql, name).toBe("unavailable");
    }
  });

  // covers: RF-110
  it("says nothing of MySQL when the application does not declare it, as an application with no MySQL reads", async () => {
    const observers = await observersOf({ dependencies: { express: "^5" } });
    expect(observers).toMatchObject({ pg: "unavailable", http: "on" });
    expect(observers).not.toHaveProperty("mysql");
  });

  // covers: RF-110
  it("says it of SQLite, SQL Server, MongoDB and Prisma too, each by a package the application declares", async () => {
    const observers = await observersOf({
      dependencies: { "better-sqlite3": "^12", mssql: "^12", mongoose: "^8", "@prisma/client": "^6" },
    });
    expect(observers).toMatchObject({
      sqlite: "unavailable",
      mssql: "unavailable",
      mongodb: "unavailable",
      prisma: "unavailable",
      pg: "unavailable",
      http: "on",
    });
  });

  // covers: RF-110
  it("leaves Prisma out when a driver adapter is beside its client, as on Prisma 7, and says the adapter's driver", async () => {
    const observers = await observersOf({
      dependencies: { "@prisma/client": "^7", "@prisma/adapter-better-sqlite3": "^7" },
    });
    expect(observers).toMatchObject({ sqlite: "unavailable", http: "on" });
    expect(observers).not.toHaveProperty("prisma");
  });

  // covers: RF-110
  it("says nothing of any database whose key is left out when the application declares none of it", async () => {
    const observers = await observersOf({ dependencies: { express: "^5" } });
    const leftOut = INSTRUMENTS.filter((name) => !DRIVERLESS.has(name) && name !== "pg");
    expect(leftOut.length).toBeGreaterThan(0);
    for (const name of leftOut) expect(observers, name).not.toHaveProperty(name);
  });
});

/**
 * A driver is wrapped when the application loads it, not at the start (ADR 0209), so its «instrumented» line comes
 * late, and on a fresh process its absence looks like a failure (a pilot integration). Under `DOWNTRACE_DEBUG` the
 * start says what it found, and that.
 */
describe("the drivers the start found, under DOWNTRACE_DEBUG", () => {
  const drivers = INSTRUMENTS.filter((name) => !DRIVERLESS.has(name));

  /** The lines an agent writes at its start, with debug on or off. */
  function started(instrument: Instrument[], debug: boolean, deps: Record<string, unknown> = {}): string[] {
    const lines: string[] = [];
    const agent = new Agent(config(instrument), { log: createLogger(debug, (line) => lines.push(line)), ...deps });
    agent.start();
    void agent.stop();
    return lines.filter((line) => line.includes("drivers found"));
  }

  // covers: RF-120
  it("names every driver switch that found its driver, and says when it is wrapped", () => {
    for (const name of drivers) {
      const line = driversFoundLine({ [name]: "on" }, new Set(drivers));
      expect(line, name).toBe(
        `drivers found: ${name}; each is wrapped at its first use, once the application has loaded it, and says "instrumented" then`,
      );
    }
    expect(driversFoundLine({ pg: "on", mysql: "on", prisma: "on" }, new Set(drivers))).toMatch(
      /^drivers found: pg, mysql, prisma; /,
    );
  });

  // covers: RF-120
  it("says it found none, and of which, when none resolved", () => {
    expect(driversFoundLine({ pg: "unavailable" }, new Set(drivers))).toBe(
      `drivers found: none, of ${drivers.join(", ")}`,
    );
    expect(driversFoundLine({ pg: "off", mysql: "off" }, new Set())).toBe(
      "drivers found: none, and DOWNTRACE_INSTRUMENT looks for none",
    );
  });

  it("never names a switch that needs no driver", () => {
    expect(driversFoundLine({ http: "on", redis: "on", runtime: "on" }, new Set(INSTRUMENTS))).toMatch(
      /^drivers found: none, of /,
    );
  });

  // covers: RF-120
  it("is one line of the start, with debug on, and none with it off", () => {
    expect(started(["pg", "http"], true, { pgModule: { notAClient: true } })).toEqual([
      "[downtrace] drivers found: none, of pg",
    ]);
    expect(started(["http", "redis"], true)).toEqual([
      "[downtrace] drivers found: none, and DOWNTRACE_INSTRUMENT looks for none",
    ]);
    expect(started(["pg", "http"], false, { pgModule: { notAClient: true } })).toEqual([]);
  });
});
