import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntervalAggregator } from "../src/aggregator.ts";
import { CoarseRegister } from "../src/coarse.ts";
import type { Logger } from "../src/log.ts";
import { ProfileAggregator } from "../src/profile.ts";
import { Sender } from "../src/transport.ts";

const SRC = new URL("../src/", import.meta.url).pathname;

/**
 * Every source file, read from the directory and not from a list, **and from every directory under it**. A list
 * written by hand only checks the files somebody remembered to put in it, and the file that breaks this rule
 * next is the one added after it. The first version of this guard read `src/` and not `src/instrument/`, which
 * is a list with one entry: three files it said it checked, it never opened (gh-610).
 */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Code only: a rule about what the agent *does* must not be triggered by a comment explaining it. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function code(file: string): string {
  return codeOf(readFileSync(join(SRC, file), "utf8"));
}

/**
 * Whether this code reads the wall clock. Three ways to do it in JavaScript, and a guard that knows one of them
 * is a guard with two holes:
 *
 * - `Date.now` as a **reference** as well as a call. `options.now ?? Date.now` is a default argument, and it is
 *   how four components read the wall clock in production while this guard, which looked for `Date.now(`,
 *   passed (gh-610).
 * - `new Date()` with nothing in it, which is the present.
 * - `Date()` called as a function, which is the present as a string.
 *
 * `new Date(x)` and `Date.parse(x)` are not readings: they convert an instant somebody already has.
 */
function readsWallClock(text: string): boolean {
  return /\bDate\.now\b/.test(text) || /\bDate\s*\(\s*\)/.test(text);
}

describe("the agent's clock", () => {
  it("has sources to check", () => {
    // A rule that reads nothing passes for the wrong reason.
    expect(sources().length).toBeGreaterThan(10);
  });

  it("reads every directory of the source, not only the first", () => {
    const read = new Set(sources().map((file) => dirname(file)));
    const directories = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name).slice(SRC.length));
    expect(directories.length, "there is a subdirectory to read, or this says nothing").toBeGreaterThan(0);
    for (const directory of directories) expect(read, `${directory} was never read`).toContain(directory);
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
    const offenders = sources().filter((file) => readsWallClock(code(file)));
    expect(
      offenders,
      "these read the wall clock. An instant comes from `AgentDeps.now`, passed in and never defaulted; a " +
        "duration from `performance.now()`. A second clock is how gh-538 happened.",
    ).toEqual([]);
  });

  // The rule shown failing. It passed from the commit that wrote it by not looking, and a guard nobody has seen
  // go red is one nobody knows can (gh-610).
  it.each([
    ["a call", "const t = Date.now();"],
    ["a default argument", "this.now = options.now ?? Date.now;"],
    ["a default parameter", "constructor(now: () => number = Date.now) {}"],
    ["a reference handed over", "new Thing({ now: Date.now });"],
    ["the present as a date", "const at = new Date().getTime();"],
    ["the present as a string", "const at = Date();"],
  ])("sees the wall clock read as %s", (_what, text) => {
    expect(readsWallClock(codeOf(text))).toBe(true);
  });

  it.each([
    ["a parse", "const ms = Date.parse(value);"],
    ["a conversion", "startedAt: new Date(capture.startedAt).toISOString(),"],
    ["the agent's clock", "endedAt: new Date(this.now()).toISOString(),"],
    ["a duration", "const started = performance.now();"],
    ["a comment", "// `Date.now()` is a second clock\nconst t = this.now();"],
    ["a block comment", "/** Read with `Date.now` once. */\nconst t = this.now();"],
  ])("does not mistake %s for one", (_what, text) => {
    expect(readsWallClock(codeOf(text))).toBe(false);
  });

  // One origin, and one place that knows it. With no default clock anywhere, the only way for a component to
  // grow an absolute clock of its own is to write `performance.timeOrigin + performance.now()` again: the
  // production value and not the wall clock, so the rule above lets it through — and a second clock in every
  // test that drives `AgentDeps.now`: each piece tested, the wiring not, which is gh-498 (ADR 0126).
  it("reads the clock's origin in one file, the one that defines the clock", () => {
    const readers = sources().filter((file) => /\bperformance\.timeOrigin\b/.test(code(file)));
    expect(readers, "the origin of the agent's clock is read once, here, and passed down").toEqual(["agent.ts"]);
  });

  // What catches a wire left unconnected is the compiler, and only while the parameter is required (ADR 0126).
  // These four each keep a clock, and each fell back to `Date.now` when `agent.ts` did not pass one — which it
  // never did. Never called: what is asserted is that every line below fails to compile, and `make lint-node`
  // type-checks this file, so making a clock optional again turns it red there (gh-610).
  it("cannot be built into any of the four components that keep one", () => {
    const quiet: Logger = { warn: () => {}, debug: () => {} };
    const wire = {
      url: "",
      token: "",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node" as const, runtimeVersion: "v24" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
    };
    const unwired = (): unknown[] => [
      // @ts-expect-error: the interval aggregator needs the agent's clock
      new IntervalAggregator(),
      // @ts-expect-error: the interval aggregator needs the agent's clock
      new IntervalAggregator({ maxRoutes: 10 }),
      // @ts-expect-error: the coarse register needs the agent's clock
      new CoarseRegister(),
      // @ts-expect-error: the coarse register needs the agent's clock
      new CoarseRegister({ seconds: 10 }),
      // @ts-expect-error: the profile needs the agent's clock
      new ProfileAggregator(),
      // @ts-expect-error: the profile needs the agent's clock
      new ProfileAggregator({ windowMs: 1_000 }),
      // @ts-expect-error: the sender needs the agent's clock
      new Sender(wire),
    ];
    expect(unwired).toBeTypeOf("function");
  });
});
