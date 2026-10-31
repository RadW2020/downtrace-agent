import { describe, expect, it } from "vitest";
import {
  adviceForUnbuiltBase,
  adviceForUnlinkedBase,
  missingModulesIn,
  NO_REQUEST_REACHED,
  noProfile,
  OBSERVER_PACKAGES,
  scriptOf,
  UNPROFILED,
  type UnlinkedBase,
  unseenObservers,
} from "../src/check/hints.ts";
import { INSTRUMENTS } from "../src/config.ts";
import { OBSERVED_PACKAGES } from "../src/init/detect.ts";

/**
 * A run that left no profile is said, with the likely cause (LOC-01, COB-01). The file does not say a profile was lost,
 * so what it can tell is from the command, and from what the processes wrote.
 */

describe("what is said of a run that left no profile", () => {
  // Until DT-79 a run ended with an explicit exit lost the profile, and until a run of `check` wrote each time a
  // process had no request in flight so did Vitest's threads pool and a server killed with SIGKILL. None of them is a
  // cause any more, and naming one would send a person to change a flag that does nothing to the result (ADR 0230).
  it.each([
    "node --test --test-force-exit test/",
    "npx jest --forceExit --runInBand",
    "mocha --exit 'test/**/*.js'",
    "mocha --parallel test",
    "vitest run",
    "vitest run --pool=forks",
    "vitest run --pool=threads",
    "npm test",
  ])("does not blame a runner of: %s", (command) => {
    const said = noProfile({ command, scripts: {}, processes: 1 });
    expect(said.advice).toBe(NO_REQUEST_REACHED);
    expect(said.advice).not.toContain("--pool");
  });

  it("says what requests that no profile covers mean: a process ended with requests in flight", () => {
    expect(UNPROFILED).toContain("in flight");
    expect(UNPROFILED).not.toContain("--pool");
  });
});

/**
 * `check` loads the instrumentation by adding to the NODE_OPTIONS a run inherits. A command, or the script it runs,
 * that sets NODE_OPTIONS without keeping that value — `NODE_OPTIONS=--max-old-space-size=4096 npm test`, Jest's
 * `NODE_OPTIONS=--experimental-vm-modules jest` — starts the tests with no instrumentation, and the run leaves
 * nothing. Blaming the runner's pool there sends a person after a flag that changes nothing (the stranger campaign).
 */
describe("what is said of a run whose processes did not load the instrumentation", () => {
  const NONE = {};

  it("says that no process wrote anything, and that the command dropped the NODE_OPTIONS that load it", () => {
    const said = noProfile({ command: "NODE_OPTIONS=--max-old-space-size=4096 npm test", scripts: NONE, processes: 0 });
    expect(said.message).toBe("the run left no profile: no process of it wrote anything");
    expect(said.advice).toContain("The instrumentation loaded in no process");
    expect(said.advice).toContain("the test command sets NODE_OPTIONS=--max-old-space-size=4096");
    expect(said.advice).toContain('NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=4096"');
    expect(said.advice).not.toContain("Vitest");
    expect(said.advice).not.toContain("--pool");
  });

  it("reads the script the command runs, and names it", () => {
    const said = noProfile({
      command: "npm run test:e2e",
      scripts: { "test:e2e": "NODE_OPTIONS=--experimental-vm-modules jest --config jest-e2e.json" },
      processes: 0,
    });
    expect(said.advice).toContain('the script "test:e2e", which the test command runs, sets NODE_OPTIONS');
    expect(said.advice).toContain('NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules"');
    expect(said.advice).not.toContain("--pool");
  });

  // pnpm and yarn are Node.js programs: they load the instrumentation from the NODE_OPTIONS they are given, and write
  // as they end, around the script that dropped it and ran the tests. The run then has processes, and nothing in them.
  it("says the cause when the package manager's own processes wrote, without saying no process did", () => {
    const said = noProfile({
      command: "pnpm test",
      scripts: { test: "NODE_OPTIONS=--experimental-vm-modules jest" },
      processes: 2,
    });
    expect(said.message).toBe("the run left no profile");
    expect(said.advice).not.toContain("loaded in no process");
    expect(said.advice).toContain('the script "test", which the test command runs, sets NODE_OPTIONS');
    expect(said.advice).toContain('NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules"');
    expect(said.advice).not.toContain("Vitest");
  });

  it.each([
    "NODE_OPTIONS=--max-old-space-size=4096 npm test",
    "cross-env NODE_OPTIONS=--experimental-vm-modules jest",
    "export NODE_OPTIONS='--max-old-space-size=4096'; vitest run",
    'NODE_OPTIONS="--trace-warnings --enable-source-maps" node --test',
    "tsc && NODE_OPTIONS=--inspect node app.js",
    "NODE_OPTIONS= node app.mjs",
  ])("reads a NODE_OPTIONS that replaces the one inherited: %s", (command) => {
    expect(noProfile({ command, scripts: NONE, processes: 0 }).advice).toContain(
      "without keeping the value it inherits",
    );
  });

  it("quotes what the command set, inside the value that keeps the inherited one", () => {
    const said = noProfile({ command: 'NODE_OPTIONS="--a --b" node app.mjs', scripts: NONE, processes: 0 });
    expect(said.advice).toContain('NODE_OPTIONS="$NODE_OPTIONS --a --b"');
  });

  it.each([
    'NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=4096" npm test',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell's ${NODE_OPTIONS}, written as a script has it.
    'NODE_OPTIONS="${NODE_OPTIONS} --experimental-vm-modules" jest',
    'cross-env NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules" jest',
    'export NODE_OPTIONS="$NODE_OPTIONS --x"; vitest run',
    "MY_NODE_OPTIONS=--x node app.mjs",
    "node --max-old-space-size=4096 app.mjs",
  ])("does not blame a NODE_OPTIONS that keeps the inherited one, or is not one: %s", (command) => {
    const said = noProfile({ command, scripts: NONE, processes: 0 });
    expect(said.advice).not.toContain("without keeping the value it inherits");
  });

  it("says what no process writing most likely means, and its other cause, when nothing in the command says why", () => {
    const said = noProfile({ command: "npm test", scripts: { test: "jest" }, processes: 0 });
    expect(said.message).toBe("the run left no profile: no process of it wrote anything");
    expect(said.advice).toContain("Most likely the instrumentation loaded in no process");
    expect(said.advice).toContain("NODE_OPTIONS");
    expect(said.advice).toContain("process.exit()");
    // Vitest's threads pool leaves the batch of Vitest's own process, so it is not what no process writing is.
    expect(said.advice).not.toContain("--pool");
  });

  it("says no request reached the application, of a run whose processes wrote and kept no request", () => {
    for (const command of ["vitest run --pool=threads", "npm test"]) {
      expect(noProfile({ command, scripts: NONE, processes: 1 })).toEqual({
        message: "the run left no profile",
        advice: NO_REQUEST_REACHED,
      });
    }
  });
});

describe("the script a test command runs", () => {
  it.each([
    ["npm test", "test"],
    ["npm run test:e2e", "test:e2e"],
    ["pnpm test", "test"],
    ["pnpm run test:integration -- --runInBand", "test:integration"],
    ["yarn e2e", "e2e"],
    ["bun run test", "test"],
    ["DATABASE_URL=postgres://localhost/test npm test", "test"],
    ["NODE_OPTIONS=--x npm run e2e", "e2e"],
  ])("reads %s as the script %s", (command, script) => {
    expect(scriptOf(command)).toBe(script);
  });

  // `bun test` is Bun's runner, not the script called test (`init` spells the script `bun run test`).
  it.each(["node app.mjs", "npx jest", "vitest run", "bun test", "sh -c 'npm test'"])(
    "reads %s as no script",
    (command) => {
      expect(scriptOf(command)).toBeUndefined();
    },
  );
});

describe("what is said of a base that failed with no dependencies, because prepare was given without link", () => {
  // The stranger campaign: hackathon-starter compiles its CSS in postinstall, into a file git ignores, so its base
  // needs `prepare: "npm run scss"`; with prepare given nothing was linked, and the prepare failed on `sass: not
  // found`. What it needed was the working tree's node_modules linked first, and the report did not say so.
  const unlinked: UnlinkedBase = {
    prepare: true,
    link: undefined,
    inWorkingTree: true,
    inBase: false,
    configFile: "downtrace.json",
  };

  it("names the key, and the condition it is safe on: a prepare that does not install", () => {
    const advice = adviceForUnlinkedBase(unlinked) ?? "";
    expect(advice).toContain('"link": true');
    expect(advice).toContain("downtrace.json");
    expect(advice).toContain("If prepare does not install");
    expect(advice).toContain("before prepare runs");
  });

  it("names the file the configuration was read from, which is where the key goes", () => {
    // `--config ci/check.json`: a downtrace.json written beside it would not be read.
    const advice = adviceForUnlinkedBase({ ...unlinked, configFile: "ci/check.json" }) ?? "";
    expect(advice).toContain('to "check" in ci/check.json');
    expect(advice).not.toContain("downtrace.json");
  });

  it.each<[string, Partial<UnlinkedBase>]>([
    ["link is false, which the person chose", { link: false }],
    ["link is true, so the base was linked", { link: true }],
    ["there is no prepare, so the base was linked", { prepare: false }],
    ["the base has a node_modules, which prepare made", { inBase: true }],
    ["the working tree has no node_modules, so linking would bring nothing", { inWorkingTree: false }],
  ])("says nothing of it when %s", (_why, differs) => {
    expect(adviceForUnlinkedBase({ ...unlinked, ...differs })).toBeUndefined();
  });
});

/**
 * The modules a failed run could not find, read off its output as Node, Vitest and Jest write it (the messages are the
 * ones Node 26, Vitest 4 and Jest 30 printed for a test that requires a file nobody built). A spec that names a
 * package is the dependencies' business, and left out.
 */
describe("the modules a run's output says it could not find", () => {
  const at = "/tmp/dt/base";

  it("reads Node's CommonJS message, from the first file of its require stack", () => {
    const output = [
      "Error: Cannot find module '../lib/Adapters/Cache/SchemaCache'",
      "Require stack:",
      `- ${at}/spec/helper.js`,
      "    at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)",
    ].join("\n");
    expect(missingModulesIn(output, at)).toEqual([`${at}/lib/Adapters/Cache/SchemaCache`]);
  });

  it("reads the ESM message, Node's with the path and Vitest's with the spec", () => {
    const node = `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${at}/dist/app.js' imported from ${at}/test/b.mjs`;
    const vitest = `Error: Cannot find module '../dist/app.js' imported from ${at}/test/c.test.mjs`;
    expect(missingModulesIn(`${node}\n${vitest}`, at)).toEqual([`${at}/dist/app.js`]);
  });

  it("reads Jest's, whose file is relative to where the tests run", () => {
    expect(missingModulesIn("    Cannot find module '../dist/app' from 'test/d.test.js'", at)).toEqual([
      `${at}/dist/app`,
    ]);
  });

  it("reads through the colours a runner writes, and leaves out a package and a builtin", () => {
    const output = [
      `\u001b[31mError: Cannot find module './gen/schema.js' imported from ${at}/src/a.mjs\u001b[39m`,
      "Error: Cannot find module 'left-pad'",
      "Require stack:",
      `- ${at}/src/b.js`,
      `Error: Cannot find module '@scope/pkg/sub' imported from ${at}/src/c.mjs`,
    ].join("\n");
    expect(missingModulesIn(output, at)).toEqual([`${at}/src/gen/schema.js`]);
  });

  it("finds nothing in an output that says nothing of a module", () => {
    expect(missingModulesIn("AssertionError: expected 200, got 500", at)).toEqual([]);
  });
});

describe("the advice for a base that lacks what a build makes", () => {
  it("names what is missing, the build, and both keys, in the file the configuration was read from", () => {
    const advice = adviceForUnbuiltBase({
      missing: "lib/",
      build: "npm run build",
      prepare: false,
      configFile: "downtrace.json",
    });
    expect(advice).toContain("lib/");
    expect(advice).toContain('"prepare": "npm run build"');
    expect(advice).toContain('"link": true');
    expect(advice).toContain('to "check" in downtrace.json');
  });

  it("says what to write when the project has no build script to name", () => {
    const advice = adviceForUnbuiltBase({ missing: "dist/", build: undefined, prepare: false, configFile: "d.json" });
    expect(advice).toContain('"prepare": "<the command that builds dist/>"');
  });

  it("says the prepare given did not make it, and asks for nothing it already has", () => {
    const advice = adviceForUnbuiltBase({
      missing: "lib/",
      build: "npm run build",
      prepare: true,
      configFile: "downtrace.json",
    });
    expect(advice).toContain("prepare");
    expect(advice).toContain("lib/");
    expect(advice).not.toContain('"link": true');
  });
});

describe("the observers of a run that did not find a driver the project depends on", () => {
  // ADR 0240: every observer but pg leaves its key out when no driver of it resolved, which is «did not say» to the
  // batch. `check` reads the project's dependencies, and a database the project declares and the observer did not find
  // is what it is there to say: what that database did is absent from the run, not zero.
  const watching = { pg: "on", http: "on", redis: "on", runtime: "on" };

  it("names one left out whose driver the project depends on, with the packages", () => {
    expect(unseenObservers(watching, new Set(["express", "mysql2"]))).toEqual([
      { observer: "mysql", state: "absent", packages: ["mysql2"] },
    ]);
    expect(unseenObservers(watching, new Set(["mongoose", "@prisma/client", "@libsql/client"]))).toEqual([
      { observer: "sqlite", state: "absent", packages: ["@libsql/client"] },
      { observer: "mongodb", state: "absent", packages: ["mongoose"] },
      { observer: "prisma", state: "absent", packages: ["@prisma/client"] },
    ]);
  });

  it("names one that said unavailable, whose driver the project depends on", () => {
    expect(unseenObservers({ ...watching, pg: "unavailable" }, new Set(["slonik"]))).toEqual([
      { observer: "pg", state: "unavailable", packages: ["slonik"] },
    ]);
    expect(unseenObservers({ ...watching, pg: "unavailable" }, new Set(["@mikro-orm/postgresql"]))).toEqual([
      { observer: "pg", state: "unavailable", packages: ["@mikro-orm/postgresql"] },
    ]);
  });

  it("knows each package init says is observed, under the observer that observes it", () => {
    // Two lists of one fact: what init promises is what check misses when the observer found no driver.
    const named = Object.values(OBSERVER_PACKAGES).flat();
    expect([...named].sort()).toEqual([...OBSERVED_PACKAGES].sort());
  });

  it("says nothing of a database the project does not depend on, unavailable or left out", () => {
    // pg says unavailable in every application without Postgres: MongoDB's, Prisma's on SQLite.
    expect(unseenObservers({ ...watching, pg: "unavailable" }, new Set(["express", "mongoose"]))).toEqual([
      { observer: "mongodb", state: "absent", packages: ["mongoose"] },
    ]);
    expect(unseenObservers({ ...watching, pg: "unavailable" }, new Set(["express"]))).toEqual([]);
  });

  it("says nothing of an observer that found its driver, or that was not asked for", () => {
    const dependencies = new Set(["mysql2", "mongodb"]);
    expect(unseenObservers({ ...watching, mysql: "on", mongodb: "off" }, dependencies)).toEqual([]);
  });

  it("says only what said unavailable when the project's dependencies are not known", () => {
    expect(unseenObservers({ ...watching, pg: "unavailable" }, undefined)).toEqual([
      { observer: "pg", state: "unavailable", packages: [] },
    ]);
  });

  it("says nothing of a run that said nothing of any observer", () => {
    expect(unseenObservers({}, new Set(["mysql2", "pg"]))).toEqual([]);
  });

  it("knows a package for every observer of a dependency, and only of those", () => {
    const ofDependencies = INSTRUMENTS.filter((name) => name !== "http" && name !== "runtime");
    expect(Object.keys(OBSERVER_PACKAGES).sort()).toEqual([...ofDependencies].sort());
  });
});
