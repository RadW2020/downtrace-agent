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
ajv.addKeyword("x-error");
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

  it("says, for every kind of operation, whether it is an error", () => {
    // Every value of the enum is classified, both ways, beside the enum itself: a kind that is not an error is
    // something the route ran — a query, an outgoing call, a Redis command — and it must never reach a list of
    // errors (ERR-01), while a kind of error that nobody marked would never reach it. The keys are compared with
    // the enum, so a value added to it without saying which it is fails here (DT-16).
    const defs = (AGGREGATES_SCHEMA_V0 as { $defs: Record<string, { properties?: Record<string, unknown> }> }).$defs;
    const kind = defs.Operation?.properties?.kind as { enum?: string[]; "x-error"?: Record<string, unknown> };
    const marks = kind["x-error"] ?? {};
    expect(Object.keys(marks).sort()).toEqual([...(kind.enum ?? [])].sort());
    for (const [value, mark] of Object.entries(marks)) expect(typeof mark, value).toBe("boolean");
    // The three that are not errors are the three things a route runs, and the rest are errors.
    expect(
      Object.entries(marks)
        .filter(([, isError]) => !isError)
        .map(([value]) => value),
    ).toEqual(["query", "call", "command"]);
  });

  it("says, for the sources of error, which kind of error arrives as each value", () => {
    // The declaration's lists hold the values of the two `kind` enums that are errors — inside a request, the ones
    // `x-error` marks; outside, every one — so the cloud can count a declared source only when the protocol
    // carries it. The lists are compared against the enums themselves, so a value added to a kind without its
    // source fails here, and so does a kind that is not an error turning up as a source.
    const defs = (AGGREGATES_SCHEMA_V0 as { $defs: Record<string, { properties?: Record<string, unknown> }> }).$defs;
    const kind = (name: string) =>
      (defs[name]?.properties?.kind as { enum?: string[]; "x-error"?: Record<string, boolean> } | undefined) ?? {};
    const list = (name: string) =>
      (
        (defs.ErrorSources?.properties as Record<string, { items?: { $ref?: string } }> | undefined)?.[name]?.items
          ?.$ref ?? ""
      ).replace("#/$defs/", "");
    const sourceEnum = (name: string) => (defs[name] as { enum?: string[] } | undefined)?.enum ?? [];
    const inDef = list("inRequest");
    const outDef = list("outsideRequest");
    expect(inDef).toBeTruthy();
    expect(outDef).toBeTruthy();
    expect(inDef).not.toBe(outDef);
    const operation = kind("Operation");
    const errors = (operation.enum ?? []).filter((v) => operation["x-error"]?.[v] === true);
    expect(errors.length).toBeGreaterThan(0);
    expect(sourceEnum(inDef)).toEqual(errors);
    expect(sourceEnum(outDef)).toEqual(kind("ProcessException").enum ?? []);
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
    // A way of ending the schema does not declare is a sender that is broken or ahead of the cloud, and it
    // gets a 400 at the door rather than being stored as something nobody can read (ADR 0008, gh-598).
    expect(reason("an-ending-nobody-declared.json")).toMatch(/ending must be equal to one of the allowed values/);
    // A query is not a source of error, a value the sources do not declare, and one declared twice are all
    // declarations that do not say a thing the process is (gh-768).
    expect(reason("error-sources-with-a-query.json")).toMatch(/inRequest.*must be equal to one of the allowed values/);
    expect(reason("error-sources-with-a-repeat.json")).toMatch(/inRequest must NOT have duplicate items/);
    // A call is something the route ran, not a way an error arrives (DT-16).
    expect(reason("error-sources-with-a-call.json")).toMatch(/inRequest.*must be equal to one of the allowed values/);
    // A kind the schema does not know is a sender that is broken or ahead of the cloud, refused at the door
    // as it always was (ADR 0008, DT-16).
    expect(reason("operation-of-an-unknown-kind.json")).toMatch(/kind must be equal to one of the allowed values/);
    // A call and a command are a word and where it went, and never a path, a query string, a key or an
    // argument: the door refuses one that carries more (invariant 5, DT-16).
    expect(reason("call-with-a-path.json")).toMatch(/text must match pattern/);
    expect(reason("call-with-a-query-string.json")).toMatch(/text must match pattern/);
    expect(reason("command-with-its-key.json")).toMatch(/text must match pattern/);
    expect(reason("error-sources-with-an-unknown-value.json")).toMatch(
      /inRequest.*must be equal to one of the allowed values/,
    );
  });

  it("reads an outgoing call and a Redis command as operations a route ran, labelled by a word and a place", async () => {
    // `product.md:142`: the structural footprint is «queries by fingerprint, outgoing calls by host, Redis
    // operations». A call is its method and host, a command its name and server, and either may travel as its
    // hash alone (DT-16).
    const doc = byName(await load("valid"), "calls-and-commands.json") as unknown as {
      profile: { endpoints: { operations: { kind: string; text?: string }[] }[] };
    };
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
    const ops = doc.profile.endpoints[0]?.operations ?? [];
    expect(ops.map((o) => [o.kind, o.text])).toEqual([
      ["query", "SELECT id, price_cents FROM products WHERE id = ?"],
      ["call", "POST api.stripe.com"],
      ["command", "HGETALL cache:6379"],
      ["call", undefined],
    ]);
    // The shape of the label binds a call and a command only: a query's text has spaces, slashes and question
    // marks of its own, and stays as it was.
    const query = structuredClone(doc);
    const first = query.profile.endpoints[0]?.operations[0];
    if (first) first.text = "SELECT a FROM b WHERE c = ? AND d = '/?#'";
    expect(validate(query), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("reads a declaration of the sources of error the sender has connected", async () => {
    // A source is on its list when the process has, at the moment the batch is sealed, what produces it
    // installed; absent is «did not declare», and the two empty lists are a statement (gh-768).
    const doc = byName(await load("valid"), "error-sources.json") as unknown as {
      agent: Record<string, unknown>;
    };
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
    expect(doc.agent.errorSources).toEqual({
      inRequest: ["error", "framework", "explicit"],
      outsideRequest: ["uncaught", "unhandled-rejection", "framework", "explicit"],
    });
    // A sender that declares is also one that may declare nothing at all.
    const silent = byName(await load("valid"), "minimal.json");
    expect(silent.agent.errorSources).toBeUndefined();
    expect(validate(silent), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("reads a batch that says it is the last one of its process", async () => {
    const doc = byName(await load("valid"), "the-last-batch-of-a-process.json") as unknown as {
      ending?: string;
    };
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
    expect(doc.ending).toBe("signal");
  });

  it("takes every declared ending and nothing else", async () => {
    // Enumerated from the schema: a hand-written list only checks the endings somebody remembered, and the
    // cloud writes one sentence per ending (gh-598, ERR-04).
    const declared = (AGGREGATES_SCHEMA_V0.properties as { ending: { enum: string[] } }).ending.enum;
    expect(declared).toEqual(["signal", "exit", "idle"]);
    for (const ending of declared) {
      const doc = byName(await load("valid"), "minimal.json") as unknown as { ending?: string };
      doc.ending = ending;
      expect(validate(doc), `${ending}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it("takes a batch with no ending at all, which is what every sender says today", async () => {
    // Absent is «this sender did not say», never «it ended badly»: an instrumentation older than 0.9.0 never
    // says it, and a process an exception killed cannot (ADR 0093's reading, applied here).
    const doc = byName(await load("valid"), "minimal.json") as unknown as { ending?: string };
    expect(doc.ending).toBeUndefined();
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
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
