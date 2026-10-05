import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { USAGE } from "../src/check/args.ts";
import { BUCKET_ROUTES, MIN_RISE_PER_REQUEST, MIN_RISE_RATIO, NOT_EVALUATED_REASONS } from "../src/check/compare.ts";
import { CONFIG_FILE, CONFIG_KEYS } from "../src/check/config.ts";
import { LOSING_RUNNERS } from "../src/check/hints.ts";
import { FAILURE_CODES, REPORT_SCHEMA } from "../src/check/report.ts";

/**
 * What `downtrace check` can say is in the source — the reasons a route is not evaluated, the ways a comparison
 * fails, the runners that lose a profile, the keys of the configuration — and what the README tells its readers
 * has to be the same list. A table written by hand drifts the day somebody adds a seventh row to the code, so each
 * one is read from the source and looked for in the text (and `downtrace init` follows what the README says).
 */

let readme: string;
beforeAll(async () => {
  // Without the backticks and the bold, which are how the README writes a flag and a status, and not part of them.
  readme = (await readFile(new URL("../README.md", import.meta.url), "utf8")).replaceAll("`", "").replaceAll("**", "");
});

const says = (text: string): boolean => readme.includes(text);

describe("the README on downtrace check", () => {
  it.each(NOT_EVALUATED_REASONS)("explains why a route is %s", (code) => {
    expect(says(code), code).toBe(true);
  });

  it.each(FAILURE_CODES)("lists the failure %s", (code) => {
    expect(says(code), code).toBe(true);
  });

  it.each(LOSING_RUNNERS)("tells what to use instead of $runner", (runner) => {
    expect(says(runner.runner), runner.runner).toBe(true);
    expect(says(runner.use), runner.use).toBe(true);
  });

  it.each(BUCKET_ROUTES)("names the bucket %s", (bucket) => {
    expect(says(bucket), bucket).toBe(true);
  });

  it.each(CONFIG_KEYS)("documents the key %s of the configuration", (key) => {
    expect(readme).toMatch(new RegExp(`\\| ${key} \\|`));
  });

  it("names the configuration file and the schema of the JSON", () => {
    expect(says(CONFIG_FILE)).toBe(true);
    expect(says(`schema: "${REPORT_SCHEMA}"`)).toBe(true);
  });

  it("states the thresholds the code has", () => {
    expect(says(`${Math.round((MIN_RISE_RATIO - 1) * 100)}%`)).toBe(true);
    expect(says(MIN_RISE_PER_REQUEST === 0.5 ? "half an execution" : String(MIN_RISE_PER_REQUEST))).toBe(true);
  });

  it("documents every option of the command", () => {
    for (const option of USAGE.match(/--[a-z]+/g) ?? []) {
      if (option === "--help" || option === "--version") continue;
      expect(says(option), option).toBe(true);
    }
  });

  it("says what each exit status is", () => {
    for (const status of ["0 no route got worse", "1 at least one did", "2 no comparison could be made"]) {
      expect(says(status), status).toBe(true);
    }
  });
});
