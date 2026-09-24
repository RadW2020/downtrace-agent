import { EXPLICIT, FRAMEWORK } from "./exceptions.ts";
import { registered } from "./registered.ts";
import { meaningful, sanitizeMessage, sanitizeValues } from "./sanitize.ts";

/**
 * What the application hands over itself.
 *
 * `product.md:372` (ERR-02): «The application can hand the instrumentation an error it handled itself, with
 * structural context and under the same rules as everything else that leaves the server: sanitised, omitted
 * when in doubt, withheld in minimal mode, attributed to the request in progress when there is one.
 * Installing without touching the code stays the default; the explicit path exists for what no hook can see.»
 *
 * Which errors that is, in so many words: a `catch` that handles the failure and carries on — a retry, a
 * fallback, a cache that could not be written — and an error the application deliberately turns into a 4xx or
 * a 2xx. No hook can see either of them, because from the outside nothing went wrong. Everything else the
 * instrumentation already observes on its own, and this call is not the way to send it.
 *
 * The shape is the tracker's on purpose, so that replacing the import is the migration. The one difference
 * that cannot be hidden is the return: a tracker returns an event id and this returns nothing, because the
 * instrumentation has no identifier to give — an error's identifier is the cloud's digest of its signature,
 * and it is not computed here.
 */

/** At most this many keys of a context travel. Eight is a shape; past that it is a payload. */
export const MAX_CONTEXT_KEYS = 8;
/** A key longer than this is not a name. */
export const MAX_CONTEXT_KEY_LENGTH = 32;
/** And a value longer than this is prose, which is not what a structural context is for. */
export const MAX_CONTEXT_VALUE_LENGTH = 64;

/**
 * A key has to look like one: a name somebody wrote in their own code, of the family of a route template.
 *
 * Two conditions, and the second is the one that matters. The shape below rejects whitespace, punctuation and
 * a leading digit. And **the key has to survive the sanitiser unchanged**: `sanitizeValues` replaces anything
 * that looks like a value, so `order_12345` and `sk_live_4eC39H…` come back as `?` and are dropped here. The
 * shape alone let both through, because it only ever looked at the first character.
 *
 * Dropped rather than sanitised, unlike a value: half a key names nothing, and `order_?` is not a name
 * anybody wrote. The cloud does not check this — it stores what arrives, bounded in size, under
 * `fromService` — so this is the only place the rule lives.
 */
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Whether this is a name and not a value wearing one. */
function isKey(key: string): boolean {
  return key.length <= MAX_CONTEXT_KEY_LENGTH && KEY.test(key) && sanitizeValues(key) === key;
}

/**
 * Turns whatever the application passed as a context into what may leave the server, or into nothing.
 *
 * External input, so it arrives as `unknown` and is validated here, at the boundary. The rules are the ones
 * every other text out of the user's code obeys (`sanitize.ts`, invariant 5): a string is sanitised as prose
 * **and omitted when too little of it survives**, exactly as an error message is (ADR 0084); a number never
 * travels, because an order id, a user id and a price are all numbers; and a boolean travels as it is, being
 * one of two words. Everything else is dropped: an object, an array, a function and a symbol are values with
 * an inside, and there is no bound on what a nested one would carry.
 *
 * **What this guarantees, and what it does not.** It replaces what *looks like* a value — which shapes those are,
 * and in what order, is `sanitize.ts` — and it cannot recognise a plain word. A
 * `{ customer: "alice" }` travels whole, because nothing here can tell a first name from a stage name. So the
 * guarantee is «no identifier, no address, no token», not «nothing about a person»: IMP-01 is a product
 * commitment about what Downtrace measures, and a call cannot enforce it on prose somebody else wrote. The
 * README says so in those words, and says whose job the rest is.
 *
 * Nothing is counted about what was dropped: what travels is per signature and not per occurrence, so a count
 * of dropped keys would be a number about one arbitrary occurrence. The bounds are published instead, on the
 * three surfaces and in the README.
 */
export function sanitizeContext(context: unknown): Record<string, string> | undefined {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return undefined;
  const out: Record<string, string> = {};
  let kept = 0;
  // `Object.entries` walks own enumerable string keys, which is what a record written by hand has, and it
  // never reaches a prototype somebody else wrote.
  for (const [key, value] of Object.entries(context)) {
    if (kept >= MAX_CONTEXT_KEYS) break;
    if (!isKey(key)) continue;
    const text = sanitizedValue(value);
    if (text === undefined) continue;
    out[key] = text.length > MAX_CONTEXT_VALUE_LENGTH ? text.slice(0, MAX_CONTEXT_VALUE_LENGTH) : text;
    kept += 1;
  }
  return kept === 0 ? undefined : out;
}

/**
 * One value, sanitised, or undefined when it is not the kind of thing a structural context carries.
 *
 * `?` is an answer and not a failure: it says the application had something to say under that key and that
 * what it said was a value. The key survives either way, which is the difference between a context that lost
 * a field and one that never had it.
 */
function sanitizedValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const sanitised = sanitizeMessage(value);
    if (sanitised === "") return undefined;
    // The same omit-when-in-doubt rule an error message obeys (ADR 0084), applied where it was missing: a
    // value of which fewer than half the words survive says nothing and only risks what the patterns did not
    // catch, so what travels is the `?` and not the residue around it.
    return meaningful(sanitised) ? sanitised : VALUE;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  // A number is a value by the rule this package already applies to every word with a digit in it: an order
  // id, a user id and a price are all numbers, and there is no telling them apart (ADR 0083, ADR 0084).
  if (typeof value === "number" || typeof value === "bigint") return VALUE;
  return undefined;
}

/** What a value that may not travel is replaced by, here and in every sanitised text of this package. */
const VALUE = "?";

/**
 * Hands an error the application handled to the instrumentation.
 *
 * Attributed to the request being served when there is one, and to the process when there is not. Never
 * throws, whatever it is given and whatever state the instrumentation is in: an application that is already
 * recovering from a failure must not be handed a second one by its telemetry (invariant 2). With no
 * instrumentation running — unconfigured, not started, already shut down — it does nothing at all.
 *
 * ```js
 * import { captureException } from "@downtrace/agent";
 *
 * try {
 *   await provider.authorize(order);
 * } catch (err) {
 *   captureException(err, { stage: "authorize", retryable: true });
 *   return fallback(order);
 * }
 * ```
 */
export function captureException(error: unknown, context?: unknown): void {
  registered()?.report({ error, context, kind: EXPLICIT });
}

/** The four arguments Express recognises an error-handling middleware by. Structural, so express is not a dependency. */
export type ErrorRequestHandler = (err: unknown, req: unknown, res: unknown, next: (err?: unknown) => void) => void;

/**
 * The one line the «no code» default needs for the exceptions a framework turns into a 5xx.
 *
 * Express carries a thrown or rejected handler to `next(err)`, walks the error-handling layers in the order
 * they were registered and, if nobody answered, hands the error to `finalhandler`. **Nothing on that path
 * publishes anything**: `http.server.request.start` and `response.finish` carry the request and the response,
 * not the exception, so without this a 500 arrives as a status class with no type, message or stack.
 *
 * It is a middleware and not a hook because the alternatives all change what the process does, which is what
 * invariant 2 forbids: seeing the error from `app.handle` means passing our own final callback and
 * re-implementing `finalhandler`, and the only other observation point is inside Express's own router, an
 * internal that has already moved once between majors. This records and calls `next(err)` **always**, with
 * the same error, so the response is the one the application would have given anyway. And it costs nothing
 * per request: it runs only when an error is already travelling.
 *
 * Register it after the routes and **before** your own error handler, because yours is likely to answer
 * rather than call `next`:
 *
 * ```js
 * import { expressErrorHandler } from "@downtrace/agent";
 *
 * app.use(expressErrorHandler());
 * app.use((err, req, res, next) => { … your own … });
 * ```
 *
 * An error that declares itself a client error — `status` or `statusCode` between 400 and 499 — is passed on
 * and not recorded: a 404 is an answer, not a failure, and an application that wants one recorded has
 * `captureException` for it.
 */
export function expressErrorHandler(): ErrorRequestHandler {
  // Declared with four parameters because that is how Express tells an error handler from a middleware, and
  // named because a stack trace through an anonymous arrow says nothing to whoever reads it.
  return function downtraceErrorHandler(err: unknown, _req: unknown, _res: unknown, next: (e?: unknown) => void) {
    // Nothing here reads the error. Reading a property of the application's object is running the
    // application's code —a getter, a `Proxy` trap—, and what that throws would reach the next handler as if
    // it were the error: it did, until gh-664. Whether it is a client's is decided inside `report`, behind the
    // guard, where a failure is counted as the instrumentation's own; with nothing running, nothing reads it.
    registered()?.report({ error: err, kind: FRAMEWORK });
    // Always, and with the same error: this middleware observes and answers nothing.
    next(err);
  };
}

/**
 * Whether the error says of itself that it is a client's fault. `status` is what Express and body-parser set.
 *
 * Called by `Agent.report`, for the framework's path and from inside its guard, and never by the middleware:
 * these two reads are the application's getters running (gh-664).
 */
export function clientError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const carrier = err as { status?: unknown; statusCode?: unknown };
  for (const value of [carrier.status, carrier.statusCode]) {
    if (typeof value === "number" && value >= 400 && value < 500) return true;
  }
  return false;
}
