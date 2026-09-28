import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const TESTS = new URL("./", import.meta.url).pathname;

/**
 * ADR 0114, for everything that comes after it: «si un test nuevo afirma una duración o un ritmo, su sitio es
 * `bench-measure`, no CI».
 *
 * A rule nothing checks is a comment, and this one had already been broken once without anyone noticing:
 * `aggregator.test.ts` kept a 50 ms bound through the ADR that moved its siblings out, and it took a failure
 * under load to find it (gh-562).
 *
 * Not named `measures.test.ts`, which is what it was called first: that matches the very pattern the fast
 * suite excludes, so the guard would have been excluded from the suite it guards.
 *
 * Every test file, read from the directory and not from a list, **and from every directory under it**: a list
 * written by hand only checks the files somebody remembered to put in it. The first version of this guard
 * read `test/` and not `test/support/`, which is a list with one entry: the root — and vitest was already
 * running the file it said it checked (gh-624, the same shape as gh-610 in `clock.test.ts`).
 */
function fastSuite(): string[] {
  return readdirSync(TESTS, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".test.ts") && !name.includes("measure"))
    .sort();
}

/** Code only: a rule about what a test asserts must not fire on a comment explaining it. */
function code(file: string): string {
  return readFileSync(join(TESTS, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("what the fast suite is allowed to assert", () => {
  it("has files to check", () => {
    // A rule that reads nothing passes for the wrong reason.
    expect(fastSuite().length).toBeGreaterThan(20);
  });

  // A test file in a subdirectory is a test file the way vitest runs it — its include is `**/*.test.ts` —
  // so the guard must read it. The first version of this guard read the directory and not its
  // subdirectories, which is a list with one entry: the root. The one that breaks this rule next is the one
  // added after it (gh-624, the same shape as gh-610 in `clock.test.ts`).
  it("reads every directory that contains a fast suite test, not only the first", () => {
    const entries = readdirSync(TESTS, { recursive: true, withFileTypes: true });
    const withTests = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts") && !entry.name.includes("measure"))
        .map((entry) => entry.parentPath.slice(TESTS.length)),
    );
    const read = new Set(fastSuite().map((file) => dirname(file)));
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name).slice(TESTS.length))
      .filter((directory) => withTests.has(directory));
    expect(directories.length, "there is a subdirectory with tests to read, or this says nothing").toBeGreaterThan(0);
    for (const directory of directories) expect(read, `${directory} was never read`).toContain(directory);
  });

  // Measuring an elapsed time and comparing it against a constant is the shape. Reading the clock is not:
  // half this suite drives one on purpose, and an instant handed to the code under test says nothing about
  // how long anything took.
  it("compares no elapsed time against a number", () => {
    const offenders = fastSuite().filter((file) => {
      const body = code(file);
      const measures = /(performance\.now\(\)\s*-|Date\.now\(\)\s*-\s*start)/.test(body);
      const bounds = /toBeLessThan(OrEqual)?\(/.test(body);
      return measures && bounds;
    });
    expect(
      offenders,
      "these measure a duration and bound it, which talks about the machine as much as about the code. " +
        "Name the file `*.measure.test.ts` and it runs under `make bench-measure`, where the number means " +
        "something (ADR 0032, ADR 0114).",
    ).toEqual([]);
  });
});
