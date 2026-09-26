import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_PROTOCOL_VERSIONS_V0,
  AGGREGATES_PATH,
  AGGREGATES_SCHEMA_V0,
  CALLS_PER_REQUEST_BOUNDARIES_V0,
  CALLS_PER_REQUEST_BUCKETS_V0,
  callsPerRequestBucket,
  PROTOCOL_VERSION,
} from "../src/index.ts";

const fixtures = fileURLToPath(new URL("../schema/v0/fixtures/", import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

async function load(kind: "valid" | "invalid"): Promise<[string, unknown][]> {
  const dir = `${fixtures}${kind}/`;
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(names.map(async (f) => [f, JSON.parse(await readFile(dir + f, "utf8"))] as [string, unknown]));
}

/** One fixture by name, typed loosely: these tests poke at the document on purpose. */
function byName(all: [string, unknown][], name: string): { agent: Record<string, unknown> } {
  const found = all.find(([n]) => n === name);
  if (!found) throw new Error(`no fixture called ${name}`);
  return structuredClone(found[1]) as { agent: Record<string, unknown> };
}

describe("aggregates schema v0", () => {
  it("exports the ingest path defined in the schema", () => {
    const path = (AGGREGATES_SCHEMA_V0 as { "x-ingest-path"?: string })["x-ingest-path"];
    expect(path).toBeDefined();
    expect(AGGREGATES_PATH).toBe(path);
  });

  it("exports exactly the versions the schema accepts, newest last", () => {
    const accepted = (AGGREGATES_SCHEMA_V0.properties.protocol as { enum: string[] }).enum;
    // What the agent stamps on a batch and what a consumer checks against are generated from this enum. Published
    // as `dist/`, they are read without the schema at hand, so a copy that drifts from it would be believed.
    expect([...ACCEPTED_PROTOCOL_VERSIONS_V0]).toEqual(accepted);
    expect(PROTOCOL_VERSION).toBe(accepted[accepted.length - 1]);
  });

  it("says, for every kind of operation and of process exception, the first minor that carries it", () => {
    // A reader tells a kind a sender cannot send from one it did not by this, so a value without it would be read as
    // carried by every sender, and one with a version nobody published as carried by none. The keys are compared
    // with the enum itself, so a value added to it without its minor fails here.
    const accepted = (AGGREGATES_SCHEMA_V0.properties.protocol as { enum: string[] }).enum;
    const defs = (AGGREGATES_SCHEMA_V0 as { $defs: Record<string, { properties?: Record<string, unknown> }> }).$defs;
    for (const name of ["Operation", "ProcessException"]) {
      const kind = defs[name]?.properties?.kind as { enum?: string[]; "x-since"?: Record<string, string> } | undefined;
      expect(kind?.enum?.length, name).toBeGreaterThan(0);
      const since = kind?.["x-since"] ?? {};
      expect(Object.keys(since).sort(), name).toEqual([...(kind?.enum ?? [])].sort());
      for (const version of Object.values(since)) expect(accepted, `${name}: ${version}`).toContain(version);
    }
  });

  it("never drops a minor it once published", () => {
    // Agents already installed keep working: the cloud never stops accepting a minor it once published (ADR 0008).
    // Removing one from the enum is how a released agent starts getting 400s it cannot do anything about.
    for (const published of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      expect(ACCEPTED_PROTOCOL_VERSIONS_V0).toContain(published);
    }
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
    // Every one of them, and not only the ones named below. The name of this test said «every» and it only
    // ever checked the list, so a new invalid fixture was never checked at all (gh-344).
    for (const [name, doc] of invalid) {
      expect(validate(doc), `${name} was accepted and should not be`).toBe(false);
    }
    const reason = (name: string) => {
      expect(validate(invalid.get(name)), name).toBe(false);
      return ajv.errorsText(validate.errors);
    };
    expect(reason("counts-length.json")).toMatch(/counts.*must NOT have fewer than 35 items/);
    expect(reason("negative-count.json")).toMatch(/count must be >= 0/);
    expect(reason("unknown-protocol.json")).toMatch(/protocol must be equal to one of the allowed values/);
    expect(reason("postgres-buckets-length.json")).toMatch(/queriesPerRequest must NOT have fewer than 8 items/);
    // A partial runtime health used to be the invalid case, and since 0.7.0 it is the normal one: a runtime
    // that is not Node has no event loop (gh-285). What is invalid now is a reading with nothing in it.
    expect(reason("runtime-with-nothing-in-it.json")).toMatch(/must NOT have fewer than 1 properties/);
    expect(reason("dependency-unknown-kind.json")).toMatch(/kind must be equal to one of the allowed values/);
    // A class and a text are two answers to one question: «hash y clase» is what travels when the text
    // could not be produced safely (`product.md:104`, gh-344).
    expect(reason("operation-with-class-and-text.json")).toMatch(/must NOT be valid/);
    // An empty declaration is a way of saying nothing, and absence already says that (gh-360).
    expect(reason("withholding-with-nothing-in-it.json")).toMatch(/must NOT have fewer than 1 properties/);
    // Reporting a capture without saying when it started is reporting nothing about it (gh-378).
    expect(reason("capture-without-a-start.json")).toMatch(/must have required property 'startedAt'/);
    // An exception that happened zero times did not happen (gh-341).
    expect(reason("exception-that-did-not-happen.json")).toMatch(/count must be >= 1/);
  });

  it("reads a declaration of what the sender withholds", async () => {
    const doc = byName(await load("valid"), "withholding.json");
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
    expect(doc.agent.withholding).toEqual({ freeText: true, endpoints: 3 });
  });

  it("refuses a sender that says it is not withholding, because absence already says that", async () => {
    // `freeText: false` and no `freeText` at all would be two spellings of one thing, and two spellings is
    // how a reader ends up asking which one means what.
    const doc = byName(await load("valid"), "minimal.json");
    doc.agent.withholding = { freeText: false };
    expect(validate(doc)).toBe(false);
  });

  it("refuses an exclusion of nothing, which is not an exclusion", async () => {
    const doc = byName(await load("valid"), "minimal.json");
    doc.agent.withholding = { endpoints: 0 };
    expect(validate(doc)).toBe(false);
  });
});

describe("callsPerRequestBucket", () => {
  it("puts a count in the first bucket whose bound it does not exceed", () => {
    expect(CALLS_PER_REQUEST_BOUNDARIES_V0).toEqual([0, 1, 2, 5, 10, 20, 50]);
    expect(callsPerRequestBucket(0)).toBe(0);
    expect(callsPerRequestBucket(1)).toBe(1);
    expect(callsPerRequestBucket(2)).toBe(2);
    expect(callsPerRequestBucket(4)).toBe(3);
    expect(callsPerRequestBucket(12)).toBe(5); // the normal checkout profile: 11–20 queries
  });

  it("puts anything past the last bound in the open-ended bucket", () => {
    expect(callsPerRequestBucket(51)).toBe(CALLS_PER_REQUEST_BUCKETS_V0 - 1);
    expect(callsPerRequestBucket(10_000)).toBe(CALLS_PER_REQUEST_BUCKETS_V0 - 1);
  });
});

describe("a process exception's running total (gh-625)", () => {
  it("reads a delivery that says how many times each signature has happened since the instance started", async () => {
    const doc = byName(await load("valid"), "exceptions-with-a-running-total.json") as unknown as {
      exceptions: { count: number; total?: number }[];
    };
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
    // `count` is what happened since the last delivery the sender heard land, and `total` everything since the
    // instance started, so `total - count` is what the sender knows was already applied.
    expect(doc.exceptions.map((e) => [e.count, e.total])).toEqual([
      [2, 5],
      [1, 1],
    ]);
  });

  it("refuses a total of nothing: a signature that happened no times did not happen", async () => {
    const invalid = new Map(await load("invalid"));
    expect(validate(invalid.get("a-running-total-of-nothing.json"))).toBe(false);
    expect(ajv.errorsText(validate.errors)).toMatch(/total must be >= 1/);
  });

  it("still takes an exception with no total, which is what every older sender sends", async () => {
    // Optional, as every addition is (ADR 0008): a cloud that stopped accepting it would give every installed
    // instrumentation a 400 it can do nothing about.
    const doc = byName(await load("valid"), "process-exceptions.json") as unknown as {
      exceptions: { total?: number }[];
    };
    expect(doc.exceptions.every((e) => e.total === undefined)).toBe(true);
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
  });
});
