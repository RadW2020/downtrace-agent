import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AGGREGATES_SCHEMA_V0,
  PROTOCOL_VERSION,
  QUERIES_PER_REQUEST_BOUNDARIES_V0,
  QUERIES_PER_REQUEST_BUCKETS_V0,
  queriesPerRequestBucket,
} from "../src/index.ts";

const fixtures = fileURLToPath(new URL("../schema/v0/fixtures/", import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-queries-per-request-boundaries");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

async function load(kind: "valid" | "invalid"): Promise<[string, unknown][]> {
  const dir = `${fixtures}${kind}/`;
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(names.map(async (f) => [f, JSON.parse(await readFile(dir + f, "utf8"))] as [string, unknown]));
}

describe("aggregates schema v0", () => {
  it("accepts the version the package exports, and every earlier published minor", () => {
    const accepted = (AGGREGATES_SCHEMA_V0.properties.protocol as { enum: string[] }).enum;
    expect(accepted).toContain(PROTOCOL_VERSION);
    // Agents already installed keep working: the cloud never stops accepting a minor it once published (ADR 0008).
    expect(accepted).toContain("0.1.0");
    expect(accepted).toContain("0.2.0");
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
    expect(reason("unknown-protocol.json")).toMatch(/protocol must be equal to one of the allowed values/);
    expect(reason("postgres-buckets-length.json")).toMatch(/queriesPerRequest must NOT have fewer than 8 items/);
    expect(reason("runtime-missing-rss.json")).toMatch(/must have required property 'rssMb'/);
  });
});

describe("queriesPerRequestBucket", () => {
  it("puts a count in the first bucket whose bound it does not exceed", () => {
    expect(QUERIES_PER_REQUEST_BOUNDARIES_V0).toEqual([0, 1, 2, 5, 10, 20, 50]);
    expect(queriesPerRequestBucket(0)).toBe(0);
    expect(queriesPerRequestBucket(1)).toBe(1);
    expect(queriesPerRequestBucket(2)).toBe(2);
    expect(queriesPerRequestBucket(4)).toBe(3);
    expect(queriesPerRequestBucket(12)).toBe(5); // the normal checkout profile: 11–20 queries
  });

  it("puts anything past the last bound in the open-ended bucket", () => {
    expect(queriesPerRequestBucket(51)).toBe(QUERIES_PER_REQUEST_BUCKETS_V0 - 1);
    expect(queriesPerRequestBucket(10_000)).toBe(QUERIES_PER_REQUEST_BUCKETS_V0 - 1);
  });
});
