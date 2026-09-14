import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 */
function fastSuite(): string[] {
  return readdirSync(TESTS)
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
