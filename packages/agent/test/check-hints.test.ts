import { describe, expect, it } from "vitest";
import { adviceForNoProfile, LOSING_RUNNERS } from "../src/check/hints.ts";

/**
 * A run that left no profile is said, with the likely cause and what to use instead (LOC-01, COB-01). The file does
 * not say a profile was lost, so the command is all there is to read.
 */

/** A command line that has each runner's setting in it, written the way a person writes one. */
const COMMANDS: Record<string, string> = {
  "node --test --test-force-exit": "node --test --test-force-exit test/",
  "Jest --forceExit": "npx jest --forceExit --runInBand",
  "Mocha --exit": "mocha --exit 'test/**/*.js'",
  "Mocha --parallel": "mocha --parallel test",
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

  it.each([
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
    for (const flag of ["--test-force-exit", "--forceExit", "--exit", "--parallel", "threads"]) {
      expect(generic).toContain(flag);
    }
    expect(generic).toContain("--pool=forks");
  });

  it("names two when the command has two", () => {
    const advice = adviceForNoProfile("mocha --exit --parallel");
    expect(advice).toContain("Mocha --exit");
    expect(advice).toContain("Mocha --parallel");
  });
});
