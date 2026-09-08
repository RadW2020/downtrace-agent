/** Narrows an optional value in tests, failing loudly instead of asserting with `!`. */
export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/**
 * The integration tests skip without a database, which is right on a development machine and wrong in CI: a
 * skipped test does not go red, it goes green, so a job could pass without running any of them and nothing would
 * say so (gh-143).
 *
 * Two conditions, and the first one is why the first attempt at this was wrong. `vitest run` with no filter loads
 * these files too, so the `node` job — which has no database on purpose, because the `integration` job is what
 * covers that — would have failed on them. DOWNTRACE_REQUIRE_DB is set by the `test:integration` script, so it
 * means "this run was asked for the integration tests", which is the thing that must not silently not happen.
 * GITHUB_ACTIONS then keeps a developer's own `make test-integration` skipping politely.
 *
 * Called at module load, so the failure is the file refusing to run rather than one test reporting it.
 */
export function requireInCI(what: string, value: string | undefined, env = process.env): void {
  if (value) return;
  if (env.DOWNTRACE_REQUIRE_DB && env.GITHUB_ACTIONS) {
    throw new Error(
      `${what} is not set, and in CI a test that cannot run is a failure: this job would have passed without ` +
        `running its integration tests`,
    );
  }
  console.warn(`[test] ${what} not set: skipping integration tests`);
}
