import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { AGGREGATES_SCHEMA_V0, PROTOCOL_VERSION } from "../src/index.ts";

const fixtures = fileURLToPath(new URL("../schema/v0/fixtures/", import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

async function load(kind: "valid" | "invalid"): Promise<[string, unknown][]> {
  const dir = `${fixtures}${kind}/`;
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(names.map(async (f) => [f, JSON.parse(await readFile(dir + f, "utf8"))] as [string, unknown]));
}

describe("aggregates schema v0", () => {
  it("declares the protocol version the package exports", () => {
    expect((AGGREGATES_SCHEMA_V0.properties.protocol as { const: string }).const).toBe(PROTOCOL_VERSION);
  });

  it("accepts every valid fixture", async () => {
    const valid = await load("valid");
    expect(valid.length).toBeGreaterThanOrEqual(3);
    for (const [name, data] of valid) {
      expect(validate(data), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it("rejects every invalid fixture for the expected reason", async () => {
    const invalid = new Map(await load("invalid"));
    expect(invalid.size).toBeGreaterThanOrEqual(3);
    const reason = (name: string) => {
      expect(validate(invalid.get(name)), name).toBe(false);
      return ajv.errorsText(validate.errors);
    };
    expect(reason("counts-length.json")).toMatch(/counts.*must NOT have fewer than 35 items/);
    expect(reason("negative-count.json")).toMatch(/count must be >= 0/);
    expect(reason("unknown-protocol.json")).toMatch(/protocol must be equal to constant/);
  });
});
