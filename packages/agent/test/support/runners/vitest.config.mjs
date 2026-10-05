import { defineConfig } from "vitest/config";

/**
 * The suites of this directory and nothing else: they are collected by the run `runners.test.ts` starts, and the
 * run that starts it must not collect them, which its own include (`*.test.*`) does not.
 */
export default defineConfig({ test: { include: ["*.vitest.mjs"] } });
