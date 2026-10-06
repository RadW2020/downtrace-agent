import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { FRAMEWORK_PACKAGES, LOCKFILES, OBSERVED_PACKAGES, TEST_SCRIPTS } from "../src/init/detect.ts";
import { REGISTER_FUNCTION } from "../src/init/files.ts";
import { INIT_FAILURE_CODES, INIT_SCHEMA, MISSING_CODES } from "../src/init/report.ts";

/**
 * What `downtrace init` looks for, says and writes is in the source, and what the README tells its readers has to be
 * the same: each list is read from the source and looked for in the text. The hook it writes is the README's own,
 * character for character, so that a person who follows the README and a coding agent that runs init end with the
 * same file.
 */

let raw: string;
let readme: string;
beforeAll(async () => {
  raw = await readFile(new URL("../README.md", import.meta.url), "utf8");
  // Without the backticks and the bold, which are how the README writes a name and a status, and not part of them.
  readme = raw.replaceAll("`", "").replaceAll("**", "");
});

const says = (text: string): boolean => readme.includes(text);

describe("the README on downtrace init", () => {
  it("gives the hook init writes, as init writes it", () => {
    expect(raw).toContain(REGISTER_FUNCTION);
  });

  it.each(MISSING_CODES)("explains what %s means and what to do", (code) => {
    expect(readme).toMatch(new RegExp(`\\| ${code} \\|`));
  });

  it.each(INIT_FAILURE_CODES)("names the failure %s", (code) => {
    expect(says(code), code).toBe(true);
  });

  it.each(TEST_SCRIPTS)("names the test script %s", (script) => {
    expect(says(script), script).toBe(true);
  });

  it.each([...FRAMEWORK_PACKAGES, ...OBSERVED_PACKAGES])("names the package %s it looks for", (name) => {
    expect(says(name), name).toBe(true);
  });

  it.each(LOCKFILES.map(([file]) => file))("names the lockfile %s", (file) => {
    expect(says(file), file).toBe(true);
  });

  it("names the schema of the JSON and says what each exit status is", () => {
    expect(says(`schema: "${INIT_SCHEMA}"`)).toBe(true);
    for (const status of ["0 configured", "1 something could not be detected or done", "2 a file it reads"]) {
      expect(says(status), status).toBe(true);
    }
  });

  it("tells a project without the package to run it under the package's own name", () => {
    expect(says("npx @downtrace/agent init")).toBe(true);
  });
});
