import { AGGREGATES_SCHEMA_V0 } from "@downtrace/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { enterRequest, recordOperationIn } from "../src/context.ts";
import { ErrorFingerprintCache } from "../src/errors.ts";
import { FingerprintCache } from "../src/fingerprint.ts";
import type { Logger } from "../src/log.ts";
import { PROFILE_WINDOW_MS, ProfileAggregator } from "../src/profile.ts";
import { Sender } from "../src/transport.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword("x-latency-boundaries-ms");
ajv.addKeyword("x-calls-per-request-boundaries");
ajv.addKeyword("x-ingest-path");
const validate = ajv.compile(AGGREGATES_SCHEMA_V0);

/**
 * Invariant 5, asked of the thing that actually leaves: the serialised body.
 *
 * Every other test here asks a function. A function can be right while the value it returns is put somewhere
 * else, or copied, or logged — so the last word belongs to the bytes the sender would POST. This drives the
 * real caches, the real profile and the real sender, and greps what came out (gh-368).
 *
 * It is not a proof. A finite list of hostile inputs never is, and PostgreSQL's grammar is somebody else's:
 * what this fixes in place is that each of these **specific** ways of being wrong ends in omission.
 */
const HOSTILE: [string, string][] = [
  ["unicode dollar tag", "SELECT $étiquette$confidential_customer_name$étiquette$"],
  ["invalid dollar tag", "SELECT $a-b$ana@cliente.com$a-b$"],
  ["dollar tag after a placeholder", "SELECT $1x$ana@cliente.com$1x$"],
  ["nested comment", "SELECT /* nota /* interna */ token=sk-live-9f1c */ 1"],
  ["nested comment left open", "SELECT /* nota /* interna */ ana@cliente.com"],
  ["unterminated identifier", `SELECT * FROM "orders WHERE email = 'ana@cliente.com' AND id = 4821`],
  ["interpolated identifier", `SELECT * FROM "user ana@cliente.com 4821"`],
  ["literal", "SELECT * FROM t WHERE email = 'ana@cliente.com'"],
  ["dollar body", "SELECT $$sk-live-9f1c$$"],
];
const THROWN: [string, unknown][] = [
  ["an Error", new Error("user ana@cliente.com not found")],
  ["a thrown object", { message: "token sk-live-9f1c rejected" }],
  ["a thrown string", "id 4821 is gone"],
];
const SECRETS = ["confidential_customer_name", "ana@cliente.com", "sk-live-9f1c", "4821", "étiquette", "token="];

describe("what actually leaves, in the bytes", () => {
  it("carries none of it, and is still a batch the schema accepts", async () => {
    const fingerprints = new FingerprintCache();
    const errors = new ErrorFingerprintCache();
    const profile = new ProfileAggregator({
      now: (() => {
        let t = 1_000_000;
        return () => (t += PROFILE_WINDOW_MS);
      })(),
    });

    const ctx = enterRequest();
    for (const [, sql] of HOSTILE) {
      recordOperationIn(ctx, { kind: "query", fingerprint: fingerprints.get(sql), startedAt: 0, endedAt: 1 });
    }
    for (const [, err] of THROWN) {
      recordOperationIn(ctx, { kind: "error", fingerprint: errors.get(err), startedAt: 0, endedAt: 1, failed: true });
    }
    profile.record("GET", "/orders/:id", [...(ctx.operations?.values() ?? [])]);
    const rotated = profile.rotate();
    expect(rotated, "the window should have rotated").not.toBeNull();

    let body = "";
    const sender = new Sender({
      url: "http://sink.invalid",
      token: "t",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v0" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    // A batch needs an interval: the profile rides with one, it is not a batch on its own.
    sender.enqueue({ start: Date.now() - 10_000, durationMs: 10_000, endpoints: [] });
    if (rotated) sender.enqueueProfile(rotated);
    expect(await sender.flush()).toBe(true);
    expect(body, "nothing was sent").not.toBe("");

    for (const secret of SECRETS) {
      expect(body, `«${secret}» reached the wire`).not.toContain(secret);
    }
    expect(validate(JSON.parse(body)), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("still carries the operations, so the test above is not passing on an empty batch", async () => {
    const fingerprints = new FingerprintCache();
    const ctx = enterRequest();
    for (const [, sql] of HOSTILE) {
      recordOperationIn(ctx, { kind: "query", fingerprint: fingerprints.get(sql), startedAt: 0, endedAt: 1 });
    }
    const operations = [...(ctx.operations?.values() ?? [])];
    expect(operations.length).toBeGreaterThanOrEqual(6);
    // And the ones that were understood do carry their label: omission has to be the exception, or the
    // profile would be useless and this test would prove nothing.
    expect(operations.some((o) => o.text !== "")).toBe(true);
  });
});
