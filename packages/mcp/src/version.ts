import { readFileSync } from "node:fs";

/**
 * The version this server reports in its handshake, read from the manifest npm publishes.
 *
 * It used to be a constant, with a comment explaining that the manifest «sits at a different depth in
 * `src` and in `dist`». That is checkable and it is not true: `src/version.ts` and `dist/index.js` are
 * both one level below the package root, so the same relative URL resolves in either. What the constant
 * did cost was real — the release bumped the manifest, nothing bumped the constant, and `main` went red
 * on the first publish of this package (gh-418).
 *
 * One number, in the file npm is going to ship anyway. The test that used to hold two copies together
 * now checks that this read works, which is the thing that would break if the layout ever changed.
 */
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version?: unknown;
};

// `as` at the boundary, like every other external read: a manifest is a file on disk, and one without a
// version is a package that cannot say what it is.
export const VERSION = typeof manifest.version === "string" ? manifest.version : "0.0.0-unknown";
