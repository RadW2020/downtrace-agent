import { createReferenceApp } from "./app.ts";

const ref = createReferenceApp();
const { port, providerPort } = await ref.start();
console.log(
  JSON.stringify({
    msg: "reference-app listening",
    port,
    providerPort,
    version: ref.config.appVersion,
    admin: ref.config.adminEnabled,
    regressions: ref.regressions.enabled(),
  }),
);

/**
 * Shutting down without cutting anything off.
 *
 * `process.exit()` is immediate: it does not wait for a promise in flight and it does not fire `beforeExit`.
 * An application that calls it the moment its servers close **races** whatever else is finishing — including
 * the instrumentation's last flush, which is where the final interval, the profile and any capture evidence
 * go (gh-371, gh-375, gh-379). This app lost that race in CI, and an application that models the product
 * should not be teaching the losing pattern (gh-383).
 *
 * So: close everything and let the event loop empty on its own, which is what lets `beforeExit` run. The
 * timer is the safety net for a close that hangs — unref'd, so it never keeps the process alive by itself.
 */
const SHUTDOWN_DEADLINE_MS = 5_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const giveUp = setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS);
    giveUp.unref();
    ref.stop().catch(() => process.exit(1));
  });
}
