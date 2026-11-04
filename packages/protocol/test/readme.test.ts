import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGGREGATES_SCHEMA_V0 } from "../src/index.ts";

// The README is the page npm shows, and it is an overview: what each field means lives in the schema's
// descriptions, and what each minor added lives in the CHANGELOG. What it has to keep up with is the list of what a
// batch carries. That it cites nothing private is public-text.test.ts's, with the rest of what npm publishes.
const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

describe("README", () => {
  it("names every top-level field of a batch", () => {
    const missing = Object.keys(AGGREGATES_SCHEMA_V0.properties).filter((field) => !readme.includes(`\`${field}\``));
    expect(missing).toEqual([]);
  });
});
