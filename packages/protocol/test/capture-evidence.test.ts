import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_PROTOCOL_VERSIONS_V0,
  AGGREGATES_SCHEMA_V0,
  CAPTURE_EVIDENCE_PATH,
  CAPTURE_EVIDENCE_SCHEMA_V0,
  captureEvidencePath,
} from "../src/index.ts";

/**
 * What an instrumentation sends back for a capture: the black box's fine detail, frozen. The contract exists
 * before anything produces it, which is the order ADR 0008 asks for — the cloud accepts first (gh-322).
 */

const fixtures = fileURLToPath(new URL("../schema/v0/fixtures/evidence/", import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-evidence-path");
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
const validate = ajv.compile(CAPTURE_EVIDENCE_SCHEMA_V0);

async function load(kind: "valid" | "invalid"): Promise<[string, unknown][]> {
  const dir = `${fixtures}${kind}/`;
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(names.map(async (f) => [f, JSON.parse(await readFile(dir + f, "utf8"))] as [string, unknown]));
}

describe("the capture evidence schema", () => {
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

  /**
   * Invariant 5, and the one refusal that matters most here. The profile is where a sender chooses whether to
   * ship the text of its queries; this path never carries it, and `additionalProperties: false` is what makes
   * that a refusal rather than a convention.
   */
  it("refuses an operation that carries the text of a query", async () => {
    const withText = (await load("invalid")).find(([n]) => n === "operation-with-text.json");
    expect(withText).toBeDefined();
    expect(validate(withText?.[1])).toBe(false);
    // And there is no field anywhere in the contract that could hold it.
    expect(JSON.stringify(CAPTURE_EVIDENCE_SCHEMA_V0)).not.toContain('"text"');
  });

  /**
   * `product.md:192` asks a capture to declare **both** coverages. Both required, so a sender cannot report
   * one and leave the other to be guessed at — a total would hide that half of it is older than the capture.
   */
  it("requires both coverages, not a total", () => {
    const coverage = (CAPTURE_EVIDENCE_SCHEMA_V0 as { $defs: { Coverage: { required: string[] } } }).$defs.Coverage;
    expect([...coverage.required].sort()).toEqual(["attachedRequests", "detailLost", "observedRequests", "truncated"]);
    expect(JSON.stringify(CAPTURE_EVIDENCE_SCHEMA_V0)).not.toContain('"totalRequests"');
  });

  /**
   * Starts and ends, not durations. The whole reason for capturing detail is order and overlap, and a duration
   * expresses neither (ADR 0068).
   */
  it("keeps an operation's start and end rather than its duration", () => {
    const op = (CAPTURE_EVIDENCE_SCHEMA_V0 as { $defs: { CapturedOperation: { required: string[] } } }).$defs
      .CapturedOperation;
    expect([...op.required].sort()).toEqual(["endMs", "hash", "startMs"]);
  });

  it("speaks exactly the versions the batch does", () => {
    // One fact, one place: the enum lives in the batch schema and `make gen` refuses a copy that has drifted.
    const batch = (AGGREGATES_SCHEMA_V0.properties.protocol as { enum: string[] }).enum;
    const mine = (CAPTURE_EVIDENCE_SCHEMA_V0 as { properties: { protocol: { enum: string[] } } }).properties.protocol
      .enum;
    expect(mine).toEqual(batch);
    expect(mine).toEqual([...ACCEPTED_PROTOCOL_VERSIONS_V0]);
  });

  it("builds the path for one capture, escaping what goes in it", () => {
    expect(CAPTURE_EVIDENCE_PATH).toContain("{id}");
    expect(captureEvidencePath("cap-1")).toBe("/v0/captures/cap-1/evidence");
    // An id is the cloud's own, but building a path by string replacement without escaping is how a caller
    // one day sends something else entirely.
    expect(captureEvidencePath("a/b")).toBe("/v0/captures/a%2Fb/evidence");
  });
});
