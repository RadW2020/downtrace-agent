import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { COMPARE_FAILURES, COMPARE_SCHEMA } from "../src/check/compare-command.ts";
import { INSPECTION_FAILURES, LINES_NAMED } from "../src/check/inspection.ts";
import { medianBucket, ROUTE_REPORT_SCHEMA, SLOWEST } from "../src/check/report-command.ts";
import { readDocumentation } from "./support/documentation.ts";

/**
 * What `downtrace report` and `downtrace compare` can say is in the source — the ways a file is refused, the schemas of
 * the JSON, the buckets of a median — and the documentation has to say the same, read from the source and looked for
 * in the text, so that a code added to the list is a code the reader is told about.
 */

let docs: string;
let readme: string;
beforeAll(async () => {
  docs = (await readDocumentation()).replaceAll("`", "").replaceAll("**", "");
  readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
});

const NUMBERS = ["zero", "one", "two", "three", "four", "five"];

describe("the documentation of downtrace report and downtrace compare", () => {
  it("puts both in the README, where it says what to do before a deploy with no account", () => {
    const start = readme.indexOf("## Before you deploy, with no account");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain("npx downtrace report");
    expect(section).toContain("npx downtrace compare");
    expect(section).toContain("guide/report.md");
  });

  it.each([...new Set([...INSPECTION_FAILURES, ...COMPARE_FAILURES])])("lists the failure %s", (code) => {
    expect(docs).toContain(`| ${code} |`);
  });

  it("names the schemas of the JSON", () => {
    expect(docs).toContain(`schema: "${ROUTE_REPORT_SCHEMA}"`);
    expect(docs).toContain(`schema: "${COMPARE_SCHEMA}"`);
  });

  it("names every bucket a median can be, as the report writes them", () => {
    for (let index = 0; index < 8; index += 1) {
      const bucket = medianBucket(Array.from({ length: 8 }, (_, i) => (i === index ? 1 : 0)));
      if (bucket === null) throw new Error(`no bucket ${index}`);
      const said =
        bucket.to === null
          ? `more than ${bucket.from - 1}`
          : bucket.from === bucket.to
            ? `${bucket.from}`
            : `${bucket.from} to ${bucket.to}`;
      expect(docs, said).toContain(said);
    }
  });

  it("says how many slowest operations and unread lines are named", () => {
    expect(docs).toContain(`the ${NUMBERS[SLOWEST]} that took longest per execution`);
    expect(docs).toContain(`the first ${LINES_NAMED === 20 ? "twenty" : LINES_NAMED} of their line numbers`);
  });
});
