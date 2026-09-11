import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { VERSION } from "../src/version.ts";

/**
 * The version travels in the handshake, so a client shows it and a bug report quotes it. It used to live
 * in two places — the manifest and a constant — held together by this test, and the first publish of this
 * package broke `main`: changesets bumps the manifest and nothing bumps a constant (gh-418).
 *
 * Now there is one number, read from the manifest at import time, and what this test protects is that
 * **the read works**: it is a relative URL, and a packaging change that moved the entry point one level
 * would break it silently at runtime, in the handshake, where nobody is looking.
 */
describe("the server's version", () => {
  it("is the one the package publishes", () => {
    expect(VERSION).toBe(manifest.version);
  });

  it("is a version and not the fallback", () => {
    // The fallback exists so a manifest without a version cannot crash the server on import. Reading it
    // here would mean the manifest was not found at all, which is the failure this file is about.
    expect(VERSION).not.toBe("0.0.0-unknown");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/**
 * And the same read has to work from the **built** package, which is the only layout a user ever runs.
 * `src/version.ts` and `dist/*.js` are both one level below the package root — the claim the old comment
 * got wrong — and this is what would catch a packaging change that stopped being true (gh-418).
 */
describe("the built package", () => {
  it("finds its manifest from dist, wherever it is run from", async () => {
    const dist = new URL("../dist/cli.js", import.meta.url);
    if (!existsSync(dist)) {
      // `make test-node` does not build first; `make build` and the publish check do, and there the
      // assertion below is the real one. Skipping loudly beats asserting nothing.
      console.warn("[mcp] dist/ is not built: run `make build` to check the packaged read too");
      return;
    }
    const manifestFromDist = JSON.parse(readFileSync(new URL("../package.json", dist), "utf8")) as {
      version: string;
    };
    expect(manifestFromDist.version).toBe(manifest.version);
  });
});
