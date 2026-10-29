import { describe, expect, it } from "vitest";
import { adviceForNoProfile, LOSING_RUNNERS, noProfile, scriptOf } from "../src/check/hints.ts";

/**
 * A run that left no profile is said, with the likely cause and what to use instead (LOC-01, COB-01). The file does
 * not say a profile was lost, so the command is all there is to read.
 */

/** A command line that has each runner's setting in it, written the way a person writes one. */
const COMMANDS: Record<string, string> = {
  "Vitest with the threads or vmThreads pool": "vitest run --pool=threads",
};

describe("what is said of a run that left no profile", () => {
  it("has a command line for every runner it knows", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(LOSING_RUNNERS.map((runner) => runner.runner).sort());
  });

  it.each(LOSING_RUNNERS)("names $runner and says what to use, when the command has it", (runner) => {
    const command = COMMANDS[runner.runner] ?? "";
    expect(runner.matches.test(command), command).toBe(true);
    const advice = adviceForNoProfile(command);
    expect(advice).toContain(runner.runner);
    expect(advice).toContain(runner.use);
  });

  it.each(["vitest run --pool=vmThreads", "vitest run --pool vmThreads", "vitest --pool='threads'"])(
    "reads the threads pool as Vitest's flag is written: %s",
    (command) => {
      expect(adviceForNoProfile(command)).toContain("Vitest");
    },
  );

  // Until DT-79 these four lost the profile, and this list named them. With no cloud the instrumentation writes
  // what it holds when the process exits, so a run that ends with an explicit exit keeps it, and blaming one of
  // them would send a person to drop a flag that does nothing to the result (ADR 0230).
  it.each([
    "node --test --test-force-exit test/",
    "npx jest --forceExit --runInBand",
    "mocha --exit 'test/**/*.js'",
    "mocha --parallel test",
    "vitest run",
    "vitest run --pool=forks",
    "jest --forceExitNever",
    "mocha --exit-code 1",
    "node --test",
    "npm test",
  ])("does not blame a command that has none of them: %s", (command) => {
    expect(adviceForNoProfile(command)).toContain("This happens when no test reaches a route");
  });

  it("lists every runner when it cannot tell which one: the generic sentence is the table", () => {
    const generic = adviceForNoProfile("npm test");
    expect(generic).toContain("Vitest with the threads or vmThreads pool");
    expect(generic).toContain("--pool=forks");
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

  it("still names a runner the command names, when it cannot tell which it was", () => {
    const said = noProfile({ command: "vitest run --pool=threads", scripts: NONE, processes: 0 });
    expect(said.advice).toContain("Most likely the instrumentation loaded in no process");
    expect(said.advice).toContain("Vitest with the threads or vmThreads pool");
    expect(said.advice).toContain("use --pool=forks");
  });

  it("says what it always said of a run whose processes wrote and kept no request", () => {
    for (const command of ["vitest run --pool=threads", "npm test"]) {
      expect(noProfile({ command, scripts: NONE, processes: 1 })).toEqual({
        message: "the run left no profile",
        advice: adviceForNoProfile(command),
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
