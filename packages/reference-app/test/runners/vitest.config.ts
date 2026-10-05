import { defineConfig } from "vitest/config";

/** The suites this directory holds, and nothing else: they are collected by the run `runners.integration.test.ts` starts. */
export default defineConfig({ test: { include: ["**/*.vitest.ts"] } });
