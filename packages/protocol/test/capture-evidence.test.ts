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
 * What an instrumentation sends back for a capture: the black box's fine detail and its coarse summary of the
 * previous minutes, frozen. The contract exists before anything produces it, which is the order ADR 0008 asks
 * for — the cloud accepts first (gh-322).
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

  /**
   * `product.md:100`: «Every sample identifies its reference and how it was selected». A sample whose
   * selection nobody stated cannot support a comparison, so the field is required and its values are an
   * enum: a free string would let a sender write «representative» and mean anything (gh-307).
   */
  it("makes a reference sample say how it was chosen", () => {
    const reference = (
      CAPTURE_EVIDENCE_SCHEMA_V0 as {
        $defs: { Reference: { required: string[]; properties: { selection: { enum: string[] } } } };
      }
    ).$defs.Reference;
    expect([...reference.required].sort()).toEqual(["population", "samples", "selection"]);
    expect(reference.properties.selection.enum).toContain("uniform-reservoir");
    // And it never says a sample is healthy, because being earlier does not make it so (`product.md:100`).
    expect(JSON.stringify(CAPTURE_EVIDENCE_SCHEMA_V0)).not.toContain('"healthy"');
  });

  /**
   * `product.md:122`: the capture freezes «the coarse summary of the previous minutes» and sends it. The
   * register that holds it is bounded (ADR 0067), and the contract pins the same bounds: a capture's worst
   * case is a number the reader of the contract can compute, not a surprise in the body.
   */
  it("carries the coarse summary, bounded by what the register holds", () => {
    const coarse = (
      CAPTURE_EVIDENCE_SCHEMA_V0 as {
        $defs: {
          CoarseSummary: {
            required: string[];
            properties: {
              windowSeconds: { minimum: number };
              routes: { maxItems: number };
              eventLoop: { maxItems: number };
            };
          };
          CoarseRoute: { properties: { seconds: { maxItems: number } } };
        };
      }
    ).$defs;
    // Optional at the top level: an instrumentation older than the summary sends none, and absent is
    // «did not send it», which the cloud stores as such (ADR 0008).
    expect((CAPTURE_EVIDENCE_SCHEMA_V0 as { required: string[] }).required).not.toContain("coarse");
    expect([...coarse.CoarseSummary.required].sort()).toEqual([
      "eventLoop",
      "routes",
      "routesDropped",
      "windowSeconds",
    ]);
    // 128 rows and the one the overflow folds into; 300 seconds of window; one reading a second, in the
    // window. The numbers are the register's own (gh-629).
    expect(coarse.CoarseSummary.properties.routes.maxItems).toBe(129);
    expect(coarse.CoarseSummary.properties.eventLoop.maxItems).toBe(300);
    expect(coarse.CoarseRoute.properties.seconds.maxItems).toBe(300);
  });

  /**
   * The seconds of the summary are instants, and the protocol's instants are integers at the wire (ADR
   * 0145): a fractional second is a clock somebody forgot to floor, and it would read as two seconds to
   * every reader that aligns the series with the dates the evidence writes.
   */
  it("keeps a coarse second an integer instant", async () => {
    const valid = (await load("valid")).find(([n]) => n === "with-coarse.json");
    expect(valid).toBeDefined();
    const doc = structuredClone(valid?.[1]) as { coarse: { routes: { seconds: { second: number }[] }[] } };
    expect(validate(doc)).toBe(true);
    const second = doc.coarse.routes[0]?.seconds[0];
    if (second === undefined) throw new Error("the fixture lost its first second");
    second.second = 1757517900.5;
    expect(validate(doc)).toBe(false);
  });

  /**
   * gh-782: the time inside the window the fine detail was not being written, and why. Optional — a sender
   * older than the field, or a shedding decided by configuration, sends none — and an enum for the reason,
   * because a free string would let a sender write a reason nobody can compare.
   */
  it("carries the shed as an optional declaration with an enum reason", () => {
    const coverage = (
      CAPTURE_EVIDENCE_SCHEMA_V0 as {
        $defs: {
          Coverage: { required: string[]; properties: { shed?: unknown } };
          Shed: {
            required: string[];
            properties: { ms: { type: string; minimum: number }; reason: { type: string; enum: string[] } };
          };
        };
      }
    ).$defs;
    // Optional in the coverage: absence is «did not declare it», which the cloud stores as such (ADR 0008).
    expect(coverage.Coverage.required).not.toContain("shed");
    expect(coverage.Coverage.properties.shed).toEqual({ $ref: "#/$defs/Shed" });
    // Both halves required when it is present, and `ms` at one: a shedding shorter than a millisecond still
    // happened, and the field says so rather than rounding it into silence.
    expect([...coverage.Shed.required].sort()).toEqual(["ms", "reason"]);
    expect(coverage.Shed.properties.ms.type).toBe("integer");
    expect(coverage.Shed.properties.ms.minimum).toBe(1);
  });

  it("borrows the shed reason from the batch's resources, and only from it", () => {
    const shedReason = (
      CAPTURE_EVIDENCE_SCHEMA_V0 as { $defs: { Shed: { properties: { reason: { enum: string[] } } } } }
    ).$defs.Shed.properties.reason.enum;
    const resources = (
      AGGREGATES_SCHEMA_V0 as { $defs: { AgentResources: { properties: { shedReason: { enum: string[] } } } } }
    ).$defs.AgentResources.properties.shedReason.enum;
    // One fact, one place: the evidence borrows the batch's enum, and `make gen` refuses a copy that drifts.
    expect(shedReason).toEqual(resources);
    expect(shedReason).toEqual(["latency", "memory"]);
  });

  it("accepts the shed and refuses the half-written sheddings", async () => {
    const valid = (await load("valid")).find(([n]) => n === "with-shed.json");
    expect(valid).toBeDefined();
    expect(validate(valid?.[1])).toBe(true);

    const invalid = await load("invalid");
    const zeroMs = invalid.find(([n]) => n === "shed-with-zero-ms.json");
    expect(zeroMs).toBeDefined();
    expect(validate(zeroMs?.[1])).toBe(false);
    const unknownReason = invalid.find(([n]) => n === "shed-with-unknown-reason.json");
    expect(unknownReason).toBeDefined();
    expect(validate(unknownReason?.[1])).toBe(false);
    const extraField = invalid.find(([n]) => n === "shed-with-an-extra-field.json");
    expect(extraField).toBeDefined();
    expect(validate(extraField?.[1])).toBe(false);
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
