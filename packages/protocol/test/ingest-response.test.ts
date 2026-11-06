import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_PROTOCOL_VERSIONS_V0,
  DESTINATION_PATH,
  type Destination,
  INGEST_RESPONSE_SCHEMA_V0,
  PROTOCOL_VERSION,
} from "../src/index.ts";

/**
 * The answer to a batch became a contract in 0.8.0, when it started carrying the captures the cloud is waiting
 * for. Until then it was an implementation detail nobody read, which is exactly why it needs a schema now: an
 * instruction with no contract is an instruction two implementations will read differently (gh-320).
 */

const fixtures = fileURLToPath(new URL("../schema/v0/fixtures/response/", import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: true });
// `date-time` is the one format the contract uses, and ajv knows no formats on its own. Taught here rather
// than pulled in as a dependency: one regular expression against RFC 3339 is the whole of what is needed, and
// it is what makes the Go side generate a `time.Time` instead of a string.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
// The path that answers a `Destination` lives beside it, as an annotation a strict validator is told about.
ajv.addKeyword("x-destination-path");
const validate = ajv.compile(INGEST_RESPONSE_SCHEMA_V0);
// The answer to a check with no batch is a `Destination` on its own, validated against the same definition.
const validateDestination = ajv.compile({ $ref: `${INGEST_RESPONSE_SCHEMA_V0.$id}#/$defs/Destination` });

type Schema = {
  required: string[];
  properties: Record<string, { $ref?: string }>;
  $defs: {
    Destination: {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
      "x-destination-path": string;
    };
  };
};
const schema = INGEST_RESPONSE_SCHEMA_V0 as unknown as Schema;

async function load(kind: "valid" | "invalid", under = fixtures): Promise<[string, unknown][]> {
  const dir = `${under}${kind}/`;
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(names.map(async (f) => [f, JSON.parse(await readFile(dir + f, "utf8"))] as [string, unknown]));
}

describe("the ingest response schema", () => {
  it("accepts every valid fixture", async () => {
    for (const [name, doc] of await load("valid")) {
      expect(validate(doc) || `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it("rejects every invalid fixture", async () => {
    for (const [name, doc] of await load("invalid")) {
      expect(validate(doc) ? `${name} was accepted and should not be` : true).toBe(true);
    }
  });

  it("has a fixture for the answer with nothing pending, which is the common case", async () => {
    const names = (await load("valid")).map(([n]) => n);
    expect(names).toContain("nothing-pending.json");
  });

  /**
   * The rule this contract lives by. `accepted` and `inserted` are the two fields the published agent never
   * read; if they ever stopped being required, an agent that starts reading the body would find them missing
   * and have no way to tell that from a cloud that took nothing (ADR 0008).
   */
  it("keeps the two fields that predate it required", () => {
    const required = (INGEST_RESPONSE_SCHEMA_V0 as { required: string[] }).required;
    expect(required).toContain("accepted");
    expect(required).toContain("inserted");
  });

  it("makes everything a capture instruction needs required, and everything else optional", () => {
    const capture = (
      INGEST_RESPONSE_SCHEMA_V0 as { $defs: { PendingCapture: { required: string[]; properties: object } } }
    ).$defs.PendingCapture;
    // Without a deadline an order never stops; without a window it has no size; without an id the evidence
    // has nowhere to go.
    expect([...capture.required].sort()).toEqual(["expiresAt", "id", "windowSeconds"]);
    // The footprint is optional because a capture may be about a route or about a dependency, never both.
    expect(Object.keys(capture.properties)).toContain("route");
    expect(Object.keys(capture.properties)).toContain("target");
  });

  it("refuses an instant that is not RFC 3339, because two sides parsing dates differently is a silent bug", () => {
    expect(
      validate({ accepted: 1, inserted: 1, captures: [{ id: "c", windowSeconds: 60, expiresAt: "tomorrow" }] }),
    ).toBe(false);
  });

  it("carries the version that introduced it", () => {
    // The response is only a contract from 0.7.0 on. A cloud speaking an earlier minor answered the same two
    // fields, which is why they are the required ones.
    expect(ACCEPTED_PROTOCOL_VERSIONS_V0).toContain("0.7.0");
    // And the newest published minor is the last of the list, which is what makes `PROTOCOL_VERSION` the one
    // an up-to-date sender stamps. This used to pin the literal "0.7.0", which is a different claim — the
    // version that introduced the response is not the version we are on — and it broke on the first bump
    // after it (gh-467).
    expect(PROTOCOL_VERSION).toBe(ACCEPTED_PROTOCOL_VERSIONS_V0.at(-1));
  });
});

/**
 * Where a token writes, said in two answers: to an accepted batch, as `destination`, and to a check that carries no
 * batch. A token that only ingests learns where its data lands, and nothing else about the project.
 */
describe("the destination", () => {
  const destinations = fileURLToPath(new URL("../schema/v0/fixtures/destination/", import.meta.url));

  // covers: RF-506
  it("names the project and the environment, and nothing else a token could read", () => {
    const destination = schema.$defs.Destination;
    expect(Object.keys(destination.properties).sort()).toEqual(["environment", "project"]);
    expect(destination.additionalProperties).toBe(false);
    // A token that names no environment writes to whichever one each batch declares, and a check has no batch.
    expect(destination.required).toEqual(["project"]);
  });

  // covers: RF-506
  it("rides on the answer to a batch, and an agent that ignores it behaves as before", () => {
    expect(schema.properties.destination?.$ref).toBe("#/$defs/Destination");
    expect(schema.required).not.toContain("destination");
    // The answer of a cloud that predates it is still a valid answer.
    expect(validate({ accepted: 1, inserted: 1 })).toBe(true);
  });

  // covers: RF-506
  it("accepts every valid answer to a check, and rejects every invalid one", async () => {
    const valid = await load("valid", destinations);
    expect(valid.length).toBeGreaterThan(0);
    for (const [name, doc] of valid) {
      expect(validateDestination(doc) || `${name}: ${ajv.errorsText(validateDestination.errors)}`).toBe(true);
    }
    const invalid = await load("invalid", destinations);
    expect(invalid.length).toBeGreaterThan(0);
    for (const [name, doc] of invalid) {
      expect(validateDestination(doc) ? `${name} was accepted and should not be` : true).toBe(true);
    }
  });

  it("is answered at the path the schema names, which is the one the package exports", () => {
    expect(DESTINATION_PATH).toBe(schema.$defs.Destination["x-destination-path"]);
    expect(DESTINATION_PATH).toBe("/v0/destination");
  });

  it("is a type a reader can hold without the rest of the answer", () => {
    const bound: Destination = { project: "nidus-api", environment: "staging" };
    const unbound: Destination = { project: "nidus-api" };
    expect(validateDestination(bound) && validateDestination(unbound)).toBe(true);
  });

  it("arrives with the minor that introduced it", () => {
    expect(ACCEPTED_PROTOCOL_VERSIONS_V0).toContain("0.14.0");
  });
});
