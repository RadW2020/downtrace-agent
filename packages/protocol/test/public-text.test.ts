import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What npm publishes — the README, the schemas with their fixtures, and what is built from src, doc comments
// included — is read by people who cannot open anything private: product.md and its identifiers (ERR-04), the
// private docs and decisions, the tickets and the issues of the private repository. Its text has to stand on its own.
const privateReference = /product\.md|\bdocs\/|\bADR \d{4}\b|\b[A-Z]{3}-\d{2}\b|\bDT-\d+\b|\bgh-\d+\b|\binvariant \d+/g;

const root = fileURLToPath(new URL("..", import.meta.url));

async function published(): Promise<string[]> {
  const under = async (dir: string) =>
    (await readdir(`${root}${dir}`, { recursive: true }))
      .filter((f) => f.endsWith(".json") || f.endsWith(".ts"))
      .map((f) => `${dir}/${f}`);
  return ["README.md", ...(await under("schema")), ...(await under("src"))];
}

describe("published text", () => {
  it("covers the README, every schema and every source file", async () => {
    const files = await published();
    expect(files).toContain("README.md");
    expect(files).toContain("schema/v0/aggregates.schema.json");
    expect(files).toContain("src/index.ts");
  });

  it("cites nothing a reader of the published package cannot open", async () => {
    const found: string[] = [];
    for (const file of await published()) {
      for (const match of (await readFile(`${root}${file}`, "utf8")).match(privateReference) ?? []) {
        found.push(`${file}: ${match}`);
      }
    }
    expect(found).toEqual([]);
  });
});
