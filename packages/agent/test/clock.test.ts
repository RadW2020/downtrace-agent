import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

/**
 * Every source file, read from the directory and not from a list. A list written by hand only checks the
 * files somebody remembered to put in it, and the file that breaks this rule next is the one added after it.
 */
function sources(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Code only: a rule about what the agent *does* must not be triggered by a comment explaining it. */
function code(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the agent's clock", () => {
  it("has sources to check", () => {
    // A rule that reads nothing passes for the wrong reason.
    expect(sources().length).toBeGreaterThan(10);
  });

  // An **instant** the agent produces is absolute and comes from `performance.timeOrigin + performance.now()`
  // — one clock, the one the fine register dates requests with. `Date.now()` is a second one: the two agree
  // when the process starts and drift apart afterwards, so a capture's start read from it could not be
  // ordered against the requests it is compared with, and a request made during a window was counted as one
  // from before it (gh-538, and gh-399 before it for the same shape of mistake).
  //
  // In the agent, the clock is `AgentDeps.now`. Everywhere else `performance.now()` measures a **duration**,
  // which is relative by design and is what ADR 0107 separated it for.
  it("reads no wall clock anywhere in the source", () => {
    const offenders = sources().filter((file) => /\bDate\.now\s*\(/.test(code(file)));
    expect(
      offenders,
      "these read the wall clock directly. An instant comes from `AgentDeps.now`; a duration from " +
        "`performance.now()`. A second clock is how gh-538 happened.",
    ).toEqual([]);
  });
});
