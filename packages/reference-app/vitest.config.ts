import { configDefaults, defineConfig } from "vitest/config";

/**
 * The fast suite does not run the integration tests; `make test-integration` does.
 *
 * `make test-node` runs the packages in parallel, and the integration suites of this package and its sibling share
 * one database — which is why `make test-integration` serializes them with --workspace-concurrency=1. Since the
 * benchmark started truncating between rounds (gh-140) they no longer merely raced, they destroyed each other, and
 * only someone developing with DATABASE_URL exported ever saw it: CI's `node` job has no database, so these files
 * skip there (gh-162).
 *
 * DOWNTRACE_REQUIRE_DB is set by the `test:integration` script and already means "this run was asked for the
 * integration tests" (gh-143), so the same signal decides both whether they are allowed to skip and whether they
 * are collected at all.
 */
const askedForIntegration = process.env.DOWNTRACE_REQUIRE_DB === "1";

export default defineConfig({
  test: {
    exclude: askedForIntegration ? configDefaults.exclude : [...configDefaults.exclude, "**/*integration*.test.ts"],
    // One database, one test at a time. The Makefile already serializes the packages; this serializes the files
    // inside one, which is the same collision one level down — four bench files each truncating between rounds.
    ...(askedForIntegration ? { fileParallelism: false } : {}),
  },
});
