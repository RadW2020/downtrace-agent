/**
 * The tracker's entry point, loaded the way its own documentation asks for in an ESM application:
 *
 * ```sh
 * node --import @downtrace/agent/register --import ./src/sentry.ts src/main.ts
 * ```
 *
 * `--import` and not a call inside the application, because `@sentry/node` instruments `pg`, `ioredis` and
 * `http` by hooking module loading, and a hook registered after the module is loaded patches nothing. It is
 * the same reason `@downtrace/agent/register` is loaded that way, and the reason the two orders are worth
 * testing: whoever loads first decides what the other one gets to see (ESC-16).
 *
 * With no `SENTRY_DSN` this does nothing at all, so loading it is never what turns the tracker on.
 */
import * as Sentry from "@sentry/node";
import { configFromEnv } from "./config.ts";

const config = configFromEnv();
if (config.trackerDsn !== "") {
  Sentry.init({
    dsn: config.trackerDsn,
    release: config.appVersion,
    environment: "reference-app",
    // Everything, because what is being compared is what the tracker observes with Downtrace beside it and
    // without it: a sampled tracker would answer that question with a coin toss.
    tracesSampleRate: 1,
    sampleRate: 1,
    // This app's requests carry a user id in a header and an order in a body. Neither is any tracker's
    // business, and the comparison does not need them (invariant 5 is Downtrace's rule, and the reference
    // app does not hand somebody else what it will not hand us).
    sendDefaultPii: false,
  });
}
