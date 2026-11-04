import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGGREGATES_SCHEMA_V0 } from "../src/index.ts";

// The README is the page npm shows, and it is an overview: what each field means lives in the schema's
// descriptions, and what each minor added lives in the CHANGELOG. What it has to keep up with is the list of what a
// batch carries, and it is read by people who cannot open anything private.
const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

describe("README", () => {
  it("names every top-level field of a batch", () => {
    const missing = Object.keys(AGGREGATES_SCHEMA_V0.properties).filter((field) => !readme.includes(`\`${field}\``));
    expect(missing).toEqual([]);
  });

  it("cites nothing a reader of the published package cannot open", () => {
    // product.md and its identifiers (ERR-04), the private docs, the tickets and the issues of the private repository.
    const privateReference = /product\.md|\bdocs\/|\b[A-Z]{3}-\d{2}\b|\bDT-\d+\b|\bgh-\d+\b|\binvariant \d+/g;
    expect(readme.match(privateReference) ?? []).toEqual([]);
  });
});
