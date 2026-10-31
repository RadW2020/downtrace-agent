// The tracker as its documentation asks an application to load it, with a DSN nothing listens on: what is counted is
// the spans it starts, not what it sends.
import * as Sentry from "@sentry/node";

Sentry.init({ dsn: "http://key@127.0.0.1:9/1", tracesSampleRate: 1 });
