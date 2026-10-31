/**
 * The tracker's entry point for a CommonJS application, written the way its own documentation asks for one:
 * required on the first line of the application's entry, or preloaded with `node --require ./instrument.cjs`.
 * Either way it runs before the application requires anything the tracker instruments, because its hooks only
 * see a module that is loaded after they exist.
 *
 * With no `SENTRY_DSN` this does nothing at all, so loading it is never what turns the tracker on.
 */
const Sentry = require("@sentry/node");

const dsn = process.env.SENTRY_DSN ?? "";
if (dsn !== "") {
  Sentry.init({
    dsn,
    environment: "reference-app",
    // Everything, for the same reason as `src/sentry.ts`: a sampled tracker would answer «what does it see with
    // Downtrace beside it» with a coin toss.
    tracesSampleRate: 1,
    sampleRate: 1,
    sendDefaultPii: false,
  });
}
