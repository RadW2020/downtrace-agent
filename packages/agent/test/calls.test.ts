import { AGGREGATES_SCHEMA_V0 } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { CallFingerprints, DEFAULT_CALL_FINGERPRINTS } from "../src/calls.ts";
import { operationKey } from "../src/context.ts";
import { hash64 } from "../src/fingerprint.ts";
import { withheldName } from "../src/minimal.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
ajv.addKeyword("x-since");
ajv.addKeyword("x-error");
ajv.compile(AGGREGATES_SCHEMA_V0);
const validateOperation = ajv.getSchema("https://downtrace.io/schema/v0/aggregates.schema.json#/$defs/Operation");

/** The operation the profile would send for one fingerprint, asked of the real schema. */
function accepted(kind: "call" | "command", fingerprint: { hash: string; text: string }): boolean {
  const operation = {
    kind,
    hash: fingerprint.hash,
    count: 1,
    totalMs: 1,
    ...(fingerprint.text === "" ? {} : { text: fingerprint.text }),
  };
  return validateOperation?.(operation) === true;
}

/**
 * What an outgoing call and a Redis command are, as operations (DT-17, ADR 0219): a word and the place it went,
 * hashed once per pair in a bounded cache, so the path that runs on every call is two map lookups.
 */
describe("the fingerprint of a call or a command", () => {
  it("is the word and the place it went, in the shape the schema requires", () => {
    const calls = new CallFingerprints("call");
    const commands = new CallFingerprints("command");
    const post = calls.get("POST", "api.stripe.com");
    const hgetall = commands.get("hgetall", "cache:6379");
    expect(post).toMatchObject({ text: "POST api.stripe.com", hash: hash64("POST api.stripe.com") });
    // ioredis names a command as the application called it; the label is its name, in capitals.
    expect(hgetall).toMatchObject({ text: "HGETALL cache:6379", hash: hash64("HGETALL cache:6379") });
    expect(post && accepted("call", post)).toBe(true);
    expect(hgetall && accepted("command", hgetall)).toBe(true);
  });

  it("carries the key that tells it apart from a query of the same hash, made once", () => {
    const calls = new CallFingerprints("call");
    const commands = new CallFingerprints("command");
    const call = calls.get("GET", "localhost:6379");
    const command = commands.get("GET", "localhost:6379");
    expect(call?.key).toBe(operationKey("call", call?.hash ?? ""));
    expect(command?.key).toBe(operationKey("command", command?.hash ?? ""));
    expect(call?.key).not.toBe(command?.key);
  });

  it("is computed once per pair, and repeating the call costs a lookup", () => {
    const calls = new CallFingerprints("call");
    const first = calls.get("POST", "api.stripe.com");
    for (let i = 0; i < 100; i += 1) expect(calls.get("POST", "api.stripe.com")).toBe(first);
    expect(calls.misses).toBe(1);
    calls.get("GET", "api.stripe.com");
    calls.get("POST", "api.sendgrid.com");
    expect(calls.misses).toBe(3);
    expect(calls.size).toBe(3);
  });

  // Invariant 3: bounded like the fingerprint cache of queries. Past the cap the answer stays right and only the
  // cost changes, because an application calling a new host per request is the one an eviction would thrash.
  it("stops growing at its cap, and still answers past it", () => {
    const calls = new CallFingerprints("call", { max: 4 });
    for (let i = 0; i < 10; i += 1) calls.get("GET", `tenant-${i}.example.com`);
    expect(calls.size).toBe(4);
    expect(calls.get("GET", "tenant-9.example.com")).toMatchObject({ text: "GET tenant-9.example.com" });
    expect(DEFAULT_CALL_FINGERPRINTS).toBeGreaterThanOrEqual(256);
  });

  // The decision on the unix socket: its place is a path, and the schema refuses a label with a slash in it —
  // a 400 of the whole batch. It travels with its hash alone, the identity; the label is what cannot travel.
  it("sends no text for a place the schema cannot carry, and keeps its identity", () => {
    const commands = new CallFingerprints("command");
    const socket = commands.get("GET", "/tmp/redis.sock");
    expect(socket?.text).toBe("");
    expect(socket?.hash).toBe(hash64("GET /tmp/redis.sock"));
    expect(socket && accepted("command", socket)).toBe(true);
    // Two sockets are two identities, label or not.
    expect(commands.get("GET", "/var/run/redis.sock")?.hash).not.toBe(socket?.hash);
    // A server the driver did not name has no place either.
    expect(commands.get("PING", "")?.text).toBe("");
    // And a word the schema would refuse is not sent as a label.
    expect(commands.get("my:cmd", "cache:6379")?.text).toBe("");
  });

  it("refuses what is not a word, so a malformed message records no operation", () => {
    const calls = new CallFingerprints("call");
    expect(calls.get(undefined, "api.stripe.com")).toBeUndefined();
    expect(calls.get(42, "api.stripe.com")).toBeUndefined();
    expect(calls.get("", "api.stripe.com")).toBeUndefined();
    expect(calls.get("X".repeat(65), "api.stripe.com")).toBeUndefined();
    expect(calls.size).toBe(0);
  });

  // `DOWNTRACE_MINIMAL=1`: no free text leaves, and the hash is a digest of the withheld name, so the analysis
  // still groups without the host ever being hashed bare (ADR 0105).
  it("withholds the text in minimal mode and hashes the withheld name", () => {
    const calls = new CallFingerprints("call", { named: withheldName });
    const post = calls.get("POST", "api.stripe.com");
    expect(post?.text).toBe("");
    expect(post?.hash).toBe(hash64(`POST ${withheldName("api.stripe.com")}`));
    expect(post?.hash).not.toBe(hash64("POST api.stripe.com"));
    expect(JSON.stringify(post)).not.toContain("stripe");
  });

  it("withholds the text of a withheld name whatever the name looks like", () => {
    // The digest of minimal mode begins with `#`, which the schema's pattern refuses on its own; the label is
    // withheld because the name is, not because of how the digest happens to be spelled.
    const calls = new CallFingerprints("call", { named: () => "withheld" });
    expect(calls.get("POST", "api.stripe.com")?.text).toBe("");
  });
});
