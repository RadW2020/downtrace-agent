/**
 * Runs `run` and says what escaped as an uncaught exception while it did.
 *
 * Node calls every `diagnostics_channel` subscriber inside a `try` of its own and rethrows what it catches on
 * `process.nextTick`, so a subscriber that throws does not fail the call that published: it ends the process a
 * tick later (gh-663). This is watched with `uncaughtExceptionMonitor`, which sees the exception and does not
 * handle it, so the runner still reports it as well and a red is never hidden by the test that looks for it.
 *
 * Measured on Node 24 and 26 for every path the observers take: the rethrow lands before the call settles. The
 * turn of the event loop after it is margin, not the wait.
 */
export async function escapedFrom<T>(run: () => Promise<T>): Promise<{ value: T; escaped: unknown[] }> {
  const escaped: unknown[] = [];
  const watch = (err: unknown): void => {
    escaped.push(err);
  };
  process.on("uncaughtExceptionMonitor", watch);
  try {
    const value = await run();
    await new Promise((resolve) => setImmediate(resolve));
    return { value, escaped };
  } finally {
    process.removeListener("uncaughtExceptionMonitor", watch);
  }
}
