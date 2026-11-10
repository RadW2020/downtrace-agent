import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DRIVERLESS } from "../src/agent.ts";
import { OBSERVER_PACKAGES } from "../src/check/hints.ts";
import { INSTRUMENTS } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { declaredDependencies as declared, declaresDriverOf } from "../src/manifest.ts";

/**
 * What the application declares, read from its `package.json` at the start (RF-110): what tells a driver the
 * application declares and the instrumentation cannot resolve from a database the application does not use (ADR 0240).
 */
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() ?? "", { recursive: true, force: true });
});

/** A directory of its own, with these files in it, by their path from it. */
async function tree(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "downtrace-manifest-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text, "utf8");
  }
  return dir;
}

const quiet: Logger = { warn: () => {}, debug: () => {} };

/** What the application declares, read from these bases, within five seconds or the signal given. */
function declaredDependencies(from: string | string[], signal = AbortSignal.timeout(5_000), log = quiet) {
  return declared({ from, signal, log });
}
const manifest = (fields: Record<string, unknown>): string => JSON.stringify({ name: "app", ...fields });

describe("the dependencies the application declares", () => {
  it("are those of the closest package.json above the entry, in every field that declares one", async () => {
    const dir = await tree({
      "package.json": manifest({
        dependencies: { mysql2: "^3" },
        devDependencies: { vitest: "^4" },
        optionalDependencies: { "better-sqlite3": "^12" },
        peerDependencies: { pg: "^8" },
      }),
      "dist/server.js": "",
    });
    const names = await declaredDependencies(path.join(dir, "dist", "server.js"));
    expect([...names].sort()).toEqual(["better-sqlite3", "mysql2", "vitest"]);
  });

  it("are read from inside a directory the process was started with, as `node .` runs it", async () => {
    const dir = await tree({ "package.json": manifest({ dependencies: { mysql2: "^3" } }) });
    expect([...(await declaredDependencies(`${dir}${path.sep}`))]).toEqual(["mysql2"]);
  });

  it("pass over a package.json that declares nothing, as the one a build writes to say its files are modules", async () => {
    const dir = await tree({
      "package.json": manifest({ dependencies: { mysql2: "^3" } }),
      "dist/package.json": JSON.stringify({ type: "module" }),
      "dist/server.js": "",
    });
    expect([...(await declaredDependencies(path.join(dir, "dist", "server.js")))]).toEqual(["mysql2"]);
  });

  it("are never a dependency's, whose own package.json lists what it was built and tested with", async () => {
    // A CLI started from `node_modules` — `node node_modules/typeorm/cli.js` — whose package declares mysql2 among its
    // devDependencies: the application is the project above `node_modules`, and it declares Postgres.
    const dir = await tree({
      "package.json": manifest({ dependencies: { pg: "^8" } }),
      "node_modules/typeorm/package.json": manifest({ devDependencies: { mysql2: "^3" } }),
      "node_modules/typeorm/cli.js": "",
    });
    const names = await declaredDependencies(path.join(dir, "node_modules", "typeorm", "cli.js"));
    expect([...names]).toEqual(["pg"]);
  });

  it("are those of every base under `check`: the runner's project and the one the tests are of", async () => {
    const runner = await tree({ "package.json": manifest({ dependencies: { vitest: "^4" } }), "run.js": "" });
    const project = await tree({ "package.json": manifest({ dependencies: { mysql2: "^3" } }) });
    const names = await declaredDependencies([path.join(runner, "run.js"), `${project}${path.sep}`]);
    expect([...names].sort()).toEqual(["mysql2", "vitest"]);
  });

  it("are none when no package.json is above the entry", async () => {
    // The temporary directory's ancestors may hold one on some machine; the root of the file system holds none.
    expect([...(await declaredDependencies(path.join(path.parse(os.tmpdir()).root, "server.js")))]).toEqual([]);
  });

  it("are none, and nothing above is read, when the closest package.json is not JSON or not an object", async () => {
    for (const text of ["{ not json", "[]", "null"]) {
      const dir = await tree({
        "package.json": manifest({ dependencies: { mysql2: "^3" } }),
        "app/package.json": text,
      });
      const lines: string[] = [];
      const log: Logger = { warn: () => {}, debug: (line) => lines.push(line) };
      const names = await declaredDependencies(path.join(dir, "app", "server.js"), undefined, log);
      expect([...names], text).toEqual([]);
      // Said, and not swallowed: the debug line names the file.
      expect(lines, text).toEqual([expect.stringContaining(path.join(dir, "app", "package.json"))]);
    }
  });

  it("leave out a field that is not an object, and keep the others", async () => {
    const dir = await tree({
      "package.json": manifest({ dependencies: ["mysql2"], devDependencies: { mariadb: "^3" } }),
    });
    expect([...(await declaredDependencies(path.join(dir, "server.js")))]).toEqual(["mariadb"]);
  });

  it("are none, and never a throw, when the read is cut short", async () => {
    const dir = await tree({ "package.json": manifest({ dependencies: { mysql2: "^3" } }) });
    expect([...(await declaredDependencies(path.join(dir, "server.js"), AbortSignal.abort()))]).toEqual([]);
  });
});

/**
 * The switches whose key is left out when no driver resolves (ADR 0240): every switch with a driver but Postgres's,
 * which says `unavailable` declared or not (ADR 0093).
 */
const LEFT_OUT = INSTRUMENTS.filter((name) => !DRIVERLESS.has(name) && name !== "pg");

describe("a database the application declares a driver of", () => {
  it("is each switch's whose key is left out when none resolves, by every package `check` reads for it", () => {
    expect(LEFT_OUT).toEqual(expect.arrayContaining(["mysql", "sqlite", "mssql", "mongodb", "prisma"]));
    for (const name of LEFT_OUT) {
      const packages = OBSERVER_PACKAGES[name] ?? [];
      expect(packages, name).not.toEqual([]);
      for (const one of packages) expect(declaresDriverOf(name, new Set([one])), `${name}: ${one}`).toBe(true);
    }
  });

  it("is not a switch's when the application declares every other switch's packages and none of its own", () => {
    for (const name of LEFT_OUT) {
      const others = Object.entries(OBSERVER_PACKAGES).flatMap(([observer, packages]) =>
        observer === name ? [] : packages,
      );
      expect(declaresDriverOf(name, new Set(others)), name).toBe(false);
    }
  });

  it("is not Prisma's when a driver adapter is beside its client, as Prisma 7 requires: its queries are the driver's", () => {
    for (const adapter of ["@prisma/adapter-pg", "@prisma/adapter-better-sqlite3", "@prisma/adapter-planetscale"]) {
      expect(declaresDriverOf("prisma", new Set(["@prisma/client", adapter])), adapter).toBe(false);
    }
    // The adapter's driver is the switch that says it.
    const sqlite = new Set(["@prisma/client", "@prisma/adapter-better-sqlite3"]);
    expect(declaresDriverOf("sqlite", sqlite)).toBe(true);
  });

  it("is none for a switch nobody reads packages for", () => {
    expect(declaresDriverOf("not-a-switch", new Set(["mysql2", "@prisma/client"]))).toBe(false);
  });
});
