import { beforeAll, describe, expect, it } from "vitest";
import { USAGE } from "../src/check/args.ts";
import {
  BEYOND_SESSION,
  BUCKET_ROUTES,
  MIN_RISE_PER_REQUEST,
  MIN_RISE_RATIO,
  NOT_EVALUATED_REASONS,
  NOT_SESSION_LEADS,
} from "../src/check/compare.ts";
import { CONFIG_FILE, CONFIG_KEYS } from "../src/check/config.ts";
import { FAILURE_CODES, REPORT_SCHEMA } from "../src/check/report.ts";
import { readDocumentation } from "./support/documentation.ts";

/**
 * What `downtrace check` can say is in the source — the reasons a route is not evaluated, the ways a comparison
 * fails, the runners that lose a profile, the keys of the configuration — and what the documentation (the README and guide/) tells its readers
 * has to be the same list. A table written by hand drifts the day somebody adds a seventh row to the code, so each
 * one is read from the source and looked for in the text (and `downtrace init` follows what the README says).
 */

let readme: string;
beforeAll(async () => {
  // Without the backticks and the bold, which are how the README writes a flag and a status, and not part of them.
  readme = (await readDocumentation()).replaceAll("`", "").replaceAll("**", "");
});

const says = (text: string): boolean => readme.includes(text);

describe("the README on downtrace check", () => {
  it.each(NOT_EVALUATED_REASONS)("explains why a route is %s", (code) => {
    expect(says(code), code).toBe(true);
  });

  it.each(FAILURE_CODES)("lists the failure %s", (code) => {
    expect(says(code), code).toBe(true);
  });

  it("tells how a command that sets NODE_OPTIONS keeps the one the instrumentation is loaded with", () => {
    expect(says('NODE_OPTIONS="$NODE_OPTIONS ')).toBe(true);
    expect(says("no process of it wrote anything")).toBe(true);
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

  it("gives the lines to paste into AGENTS.md or CLAUDE.md, as the launch copy quotes them", () => {
    const snippet =
      "Before pushing, run npx downtrace check. If it exits 1, fix the routes it lists or explain why the change is intended.";
    expect(says(snippet)).toBe(true);
    expect(says("AGENTS.md")).toBe(true);
  });

  it.each(NOT_SESSION_LEADS)("says SET %s is judged, not taken for a setting of the session", (word) => {
    expect(says(`SET ${word}`), word).toBe(true);
  });

  it.each(BEYOND_SESSION)("says a SET with the scope %s is judged", (word) => {
    expect(says(word), word).toBe(true);
  });

  it("states the thresholds the code has", () => {
    expect(says(`${Math.round((MIN_RISE_RATIO - 1) * 100)}%`)).toBe(true);
    expect(says(MIN_RISE_PER_REQUEST === 0.5 ? "half an execution" : String(MIN_RISE_PER_REQUEST))).toBe(true);
  });

  // The commands in focus: login, brief, api, stamp and verify are frozen and their pages were taken out.
  it("documents every option of check, init, report and compare", () => {
    const lines = USAGE.split("\n");
    const heads = lines.filter((line) => /^(?:Usage:)?\s*downtrace (?:check|init|report|compare)\b/.test(line));
    const start = lines.indexOf("Options of check:");
    expect(heads).toHaveLength(4);
    expect(start).toBeGreaterThan(0);
    const options = [...heads, ...lines.slice(start + 1, lines.indexOf("", start))].join("\n");
    for (const option of options.match(/--[a-z]+/g) ?? []) {
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
