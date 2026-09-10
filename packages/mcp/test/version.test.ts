import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { VERSION } from "../src/version.ts";

/**
 * The version travels in the handshake, so a client shows it and a bug report quotes it. Two places hold it
 * — the manifest, which npm publishes, and a constant, which the server can read at runtime wherever it is
 * installed — and this is what keeps them the same number.
 */
describe("the server's version", () => {
  it("is the one the package publishes", () => {
    expect(VERSION).toBe(manifest.version);
  });
});
