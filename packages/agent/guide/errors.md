# Errors

Part of the documentation of [`@downtrace/agent`](../README.md). What the instrumentation records about errors without touching your code, the two calls for the ones no hook can see, what survives each way a process ends, and how to run it beside an error tracker.

## Errors your application handled, and the ones your framework turned into a 5xx

Installing without touching your code stays the default, and it covers most of it: a query that fails, an
outgoing call that fails — a connection that is refused, a socket that resets, a timeout — and a Redis
command the driver settles as failed. Each is an error with its identity, beside the dependency's failed
call: the type, the sanitised message and the stack signature, as for a query. An exception that kills the
process is watched too.

A 5xx the dependency **answers** is not an error for it: nobody threw anything, and an identity is not
invented for it — it stays a failed call of that dependency, which is what it is. The kinds of error no hook
can cover, because from the outside nothing went wrong, are what these two calls are for.

**An error you handled.** A `catch` that retries, falls back or writes a warning and carries on, and an error
you deliberately turn into a 4xx or a 2xx. No hook can see either: the request succeeded.

```js
import { captureException } from "@downtrace/agent";

try {
  await provider.authorize(order);
} catch (err) {
  captureException(err, { stage: "authorize", retryable: true });
  return fallback(order);
}
```

The shape is the one your error tracker uses, so replacing the import is the migration. The one difference is
the return: a tracker gives you an event id and this gives you nothing, because the instrumentation has no
identifier to hand out — an error's identifier is the cloud's digest of its signature.

It is attributed to the request being served when there is one, and to the process when there is not: a
background job, a worker, start-up. It never throws, whatever you pass it, and with the instrumentation not
loaded it does nothing at all, so it is safe to leave in code that also runs without Downtrace.

**The context is structural, small and sanitised.** A flat object: at most **8 keys** of at most 32
characters, each value at most 64 characters after sanitising. A string is sanitised exactly as an error
message is — including the rule that omits it when fewer than half its words survive, and then what travels
is a `?` — a boolean travels as it is, and **a number comes out as `?`**: an order id, a user id and a price
are all numbers and there is no telling them apart, so the key survives and the value does not. Nested
objects, arrays, `null` and functions are dropped. A **key** has to be a name and survive the same sanitiser
unchanged, so `stage` and `willRetry` travel and `order_12345` or `sk_live_…` are dropped whole rather than
sent half-replaced. A tracker's `{ extra, tags, user }` hint is not read: pass the flat fields you want.

**What that guarantees, and what is yours.** The sanitising replaces what *looks like* a value, in any script:

- anything with a digit in it (`4821`, `４８２１`);
- an email (`ana@müller.de`);
- a long run of letters, digits, `_` and `-`;
- whatever is between quotes, closed or not: `'…'`, `"…"`, `“…”`, `„…“`, `‘…’`, `‚…‘`, `«…»`, `»…«`, `「…」`,
  `『…』` and backticks. An apostrophe is not a quote: the `'` of `can't` or `user's` opens nothing, and a quote closes
  only where a word ends, so `Can't find user 'alice smith' here` becomes `Can't find user ? here`. Any other `'`
  inside a word still opens one (`O'Brien` becomes `O?`), because a quote glued to a word looks the same;
- everything in a URL after its host. The scheme and a host with its port stay, because that is what the name
  of a dependency already carries: `https://api.example.com/users/alice?name=alice` becomes
  `https://api.example.com/?`. A URL whose authority holds anything else, a user and a password for one, keeps
  only its scheme: `postgres://?`. The host ends where Node's URL parser ends it, so a `\` ends it as a `/` does
  (`https://api.example.com\users\alice` becomes `https://api.example.com\?`), and a scheme such as `https:` with
  no slashes after it is read as a URL all the same (`https:api.example.com?name=alice` becomes
  `https:api.example.com?`);
- any other word with a `/` or a `\` in it, whole: a path with no scheme and its query (`/users/alice?name=alice`),
  a file path on either system (`/home/alice/orders.csv`, `C:\Users\alice\orders.csv`), a relative one, and a host
  followed by a path with no scheme in front (`api.example.com/users/alice`). Nothing of it stays, not even its
  first segment: your route templates travel as routes, and are not read by these rules. A slash on its own stays;
  a word that only joins two words with a slash goes too (`i/o`, `application/xml`);
- any other word with a query in it, whole: a word in which a `?` has a letter, a digit or an `_` after it. That is a
  host with no scheme and its query (`api.example.com?name=alice`), a query on its own (`?name=alice`), and the query
  of a scheme such as `sms:` or `mailto:` with no `//` after it (`sms:ops?body=alice`). A `?` at the end of a word, on
  its own, or with nothing but punctuation after it stays (`unexpected token?`);
- any other word with a fragment in it, whole: a word in which a `#` has something before it and a letter, a digit or
  an `_` after it. That is a host with no scheme and its fragment (`api.example.com#alice`), and the fragment of a
  scheme such as `sms:` with no `//` after it (`sms:ops#alice`). A `#` at the start of a word — a private field, a
  ticket, a channel — stays, and so does a `#` with nothing after it, a language's name (`C#`).

It cannot recognise a plain word, so `{ customer: "alice" }` travels whole. A path or a query with a space in it
ends at the space unless it is between quotes, so the words after the space travel. Nor, yet, does it recognise a
span between `‹ ›` or fullwidth quotes. The guarantee is «no identifier, no address, no token», not «nothing about a
person» — so do not put a name, an email or anything else that identifies somebody in a context. Downtrace does not
measure users, and this call cannot enforce that on prose you wrote.

**The first version that recognises all of these changes some error signatures, once.** Earlier versions let
through a URL's path, whether it followed the host with a `/` or a `\`, the query of a URL with no slashes after its
scheme, a path with no scheme and a file path, a query with no URL around it, a fragment with no URL around it, a
quoted value after an apostrophe, quotes other than `'` and `"`, backticks, a `’` inside a `‘…’` span, and digits and
addresses outside ASCII. An error whose message carried one of them is sanitised differently now, and the hash of
that text is the error's identity, so after the upgrade Downtrace lists it as a new error and the old one stops
being seen. Most of these were one error per value anyway — `user “alice” not found` and `user “bob” not found` were
two — and now they group. A message made only of ASCII keeps its signature exactly unless it carries a URL, a
backtick, a word with a `/` or a `\` in it, an apostrophe inside a word, a closing quote with a space before it, a
word in which a `?` or a closing quote has a letter, a digit or an `_` after it, or a word in which a `#` has
something before it and a word character after it, and a message with no `’` inside a `‘…’` span does too.

Only the **first** context for a signature in each window is sent, because what travels is counted per
signature and not per occurrence.

**An exception your framework turned into a 5xx.** Express hands a thrown or rejected handler to `next(err)`
and, if nobody answers, to `finalhandler`; nothing on that path publishes anything a library outside Express
can listen to, so without this line a 500 arrives as a status class with no type, message or stack. One line,
after your routes and **before** your own error handler, because yours is likely to answer rather than call
`next`:

```js
import { expressErrorHandler } from "@downtrace/agent";

app.use(expressErrorHandler());
app.use((err, req, res, next) => { /* … yours … */ });
```

It records the error and calls `next(err)` with the same error, always, so your response is the one you would
have given anyway. It costs nothing per request: it runs only when an error is already travelling. An error
that declares itself a client's fault (`status` or `statusCode` between 400 and 499) is passed on and not
recorded; if you want one of those recorded, `captureException` is the call.

Express 4 and 5. Fastify, Koa, Nest and Hono do not have one yet.

Both calls obey `DOWNTRACE_MINIMAL=1`: the message and the whole context stay on your server, and the error
still groups by its hash. That switch, and not the exclusions, is the one that withholds text.

**And the exclusions.** An endpoint you excluded with `DOWNTRACE_EXCLUDE_ENDPOINTS` is not observed at all,
and that covers these two calls too — as long as some observer is on, which is the default. The exception is
`DOWNTRACE_INSTRUMENT=none`: told to observe nothing, the instrumentation opens no context per request, so a
report made inside one has **no route to be attributed to**. It then travels as something the process saw,
with no route, and an endpoint exclusion has no endpoint to match it against. Nothing about the excluded route
travels — not its template, not its counts — but the error's own text does. If that matters to you, either
leave an observer on, or use `DOWNTRACE_MINIMAL=1`, which is the switch for text.

## Exceptions that kill the process

An uncaught exception and a promise rejected with no `catch` are watched through
`uncaughtExceptionMonitor`, which Node calls before any real handler and which **does not count as handling
the exception**. Your process ends exactly as it would have: same exit code, same stack trace. There is a
test that runs two processes, one with the instrumentation and one without, and compares both.

What is reported is the type, the sanitised message and the stack signature, counted per signature. Each
signature also travels with its running total since the process started, so a batch sent again because its answer
was lost is not counted twice, and an exception reported while another batch is in flight rides the next one. The
instrumentation keeps totals for up to 256 signatures over the life of the process; past that, a signature is sent
with its count alone and the cloud says its number may include a resend.

A process that throws more distinct signatures than the instrumentation can hold is the case it has to survive:
its window holds 32 distinct signatures, and so does the sender's accumulation while batches do not land. Past
either cap a new signature is not admitted, and what does not fit is **counted, not swallowed**: the batch says
in `droppedExceptions` how many exception events did not fit, and the cloud adds it up beside the other losses.
A process that threw 40 distinct exceptions is never read as one that threw 32.

**If the process dies, the exception is lost.** Sending is asynchronous, an uncaught exception does not go
through `beforeExit`, and there is no synchronous channel to send it on. It arrives when your application
survives what it threw — because it has its own `uncaughtException` handler, or because the rejection did
not kill it — which is the common case for the ones you can still do something about.

That is decided, not pending: the instrumentation does not write the exception to disk to deliver it at the
next start. A container's disk is usually ephemeral and the next start may be another instance, so a spool
would only help a machine with a persistent disk; and writing on the way down is synchronous I/O, with a
bound of its own to keep, at the one moment the instrumentation must not change how your process ends. What
it does instead is say the loss, and the cloud shows it per process (below). The one write on the way down
that does exist is for someone who is only inspecting: it goes to a file they named, and it never carries this
exception (below).

### What each way of ending keeps, and what it loses

Three ways a process ends — an orderly shutdown, an explicit exit, an exception that kills it — and they are
not the same for your telemetry. Every claim below names the test in `test/` that asserts it; the ones about
how a process ends use real processes, because a process that does not end cannot prove that from the inside,
and the one claim no test can reach says so in those words.

| How it ends | What reaches Downtrace | What is lost |
| --- | --- | --- |
| SIGTERM or SIGINT, with the instrumentation's own handler | everything it was holding: the interval in hand and the exceptions it had recorded, and the process still dies of that signal (`endings.test.ts`) | nothing it was holding |
| The event loop empties: nothing is left to do | the same, by the same path: the interval in hand (`endings.test.ts`) | nothing it was holding |
| `process.exit()`, after `await shutdown()` | the same, by the same path: the last batch (`shutdown.test.ts`) | nothing it was holding |
| `process.exit()`, without waiting | nothing of the last flush — the call waits for no promise and fires no `beforeExit` (`shutdown.test.ts`) | the interval in hand, the profile's window, any capture evidence |
| `process.exit()`, without waiting, **inspecting with no cloud** ([see exactly what would leave](../README.md#see-exactly-what-would-leave-your-server)) | everything it was holding, written on `exit` with `ending: "exit"` (`exit.test.ts`) | nothing it was holding |
| An exception nobody caught | what had already been sent: the earlier intervals with their runtime signals, and the exceptions that rode an earlier batch (`endings.test.ts`) | **the exception that killed it** and the interval in hand (`endings.test.ts`); and with them the profile's window and any capture evidence — **stated by reasoning and not by a test**, because nothing runs after the process is gone and what delivers those two is the flush that never happens |

The three orderly ways out — the signal, the emptied loop and `shutdown()` — are one path, and on it the
instrumentation also closes the profile's window whatever the clock says (`profile.test.ts`,
`agent.integration.test.ts`) and hands over the evidence of any capture still under way, partial rather than
silent (`agent.integration.test.ts`, `captures.test.ts`).

Two things hold in every row. The **black box** — the fine detail, the coarse summary and the reference
samples — never leaves your process except inside a capture, so it always goes with the process; that is
what it is for. And a send that fails on the very last flush is the one loss the instrumentation cannot
report to you, because what it lost travels in the next batch and there is no next batch.

**Inspecting with no cloud keeps what `process.exit()` would cut.** When `DOWNTRACE_INSPECT` names a file or
`stderr` and there is neither a token nor a URL, that destination is the whole of where the batches go, and the
instrumentation writes what it holds on the `exit` event: the last thing a process runs, with no promise and no timer
after it. The write is blocking, once, and the batch says `ending: "exit"`. It is the only blocking write the
instrumentation makes, and it is made there and nowhere else: not in a request, and not in a process that has nothing to
keep. It is why a short run that ends with an explicit exit keeps its profile ([*A test run*](check.md#a-test-run-what-each-runner-keeps-of-its-profile)), and it has two
limits, both asserted (`exit.test.ts`). With a **cloud** behind the file, nothing is written on the way out: what you
read there is what went out, and a batch written and never sent would make it say what did not. And an **exception nobody
caught** that is ending the process writes nothing, in this mode as in every other: the exception that kills the process
is lost, and the interval in hand with it.

And the last batch of the orderly endings says how the process was leaving — `ending: "signal"` for the signal,
`ending: "exit"` for an application that awaited `shutdown()` — or, inspecting with no cloud, one that called
`process.exit()` without waiting —, `ending: "idle"` for one that ran out of work — and the cloud shows that per
process, beside the instant the batch arrived. One that stopped without saying so
is shown as having stopped, with the sentence that if it died, what it had not sent is lost — and that none of
that is evidence that nothing went wrong.

## Beside your error tracker

You probably already have one installed, and you are not going to remove it the day you install this. Both
can run in the same process. Verified against `@sentry/node` **10.75.0**, with an ESM application on Express
5, `pg` and `ioredis`, loading each one the way its own documentation asks for:

```sh
node --import @downtrace/agent/register --import ./instrument.mjs server.js
```

**Either order is exact.** Both instrumentations end up wrapping the same `pg` prototype, and this one never
loads the driver itself: it resolves it from your application's root (with no loader hooks, which is what lets it
work without you importing anything) and patches the copy your application loaded once the tracker's hooks are done
with it: what your application loads at start-up, at the start of the first request; what it loads later, in a
request, in the microtask after that load, which Node announces from 22. So whichever order the two are loaded in,
your application's own load of `pg` is the only one the tracker's hooks ever see, and each one observes what it would
alone: same requests, calls per request and errors on this side, and the tracker's own `pg` spans on its side — one
`pg-pool.connect` and one query span per request, with no duplicates. A test runs the three configurations — each one
alone, and both in each order — against one another, and another one loads `pg` both ways, with an `import` and a
`require`, before the first request and after it.

**A driver your application loads lazily is counted from the request that loads it** — an `import("pg")` inside a
handler, or a route Next.js loads the first time it is asked for. What is still not counted, said here rather than
found:

- a query made in the same turn as the `require` that loads the driver, such as `require("better-sqlite3")` and a
  statement right after it;
- on Node 20, which does not announce the load, the queries of that first request, which are counted from the next one;
- a driver imported as an ES module — postgres.js's ES build, `mariadb` from 3.5 —, which is reached from the first
  request;
- with a tracker beside it, a request that loads `pg` both ways — a `require` and an `import` of it in that same
  request — gets two of the tracker's spans for each query from then on.

**A CommonJS application is verified too**, on Express 5 and `pg`, with the tracker required on the first line
of the entry or preloaded, as its documentation asks a CommonJS application to load it:

```sh
node --import @downtrace/agent/register --require ./instrument.js server.js
```

There the tracker sees `pg` only through its hook on `require`, which patches the driver as the `require` that
loads it returns, and this instrumentation patches it after that, so its `pg` spans come out as they do alone.
Node runs a `--require` before any `--import`, so that command loads the tracker first; required from the entry,
it loads second, and the test runs both.

Everything else composes cleanly, in both orders, and there is a test that compares exact counts —
requests, calls per request, errors — against each one running alone:

- **What this instrumentation reports does not change**: same requests per route, same queries, Redis
  operations and outgoing calls per request, same errors, whether the tracker is there or not.
- **Its own cost does not change either**: no internal errors, and the meter never has to give anything up.
  The hook time it reports is sampled inside its own hooks, so your tracker's work is never counted as ours.
- **Your tracker's ingestion is not reported as one of your dependencies.** `@sentry/node` sends an error
  from inside the request that reported it, so its send would otherwise be a call and a dependency of that
  route, coming and going with whether it answers before the request ends. This instrumentation recognises
  that send by the request its transport makes — a `POST` to `…/api/<project>/envelope/?sentry_version=…&sentry_key=…`
  with the `node:http` client — and does not observe it. Nothing wider: a `tunnel` you configure is a URL of
  yours, and a call your application makes to it is counted like any other.

### Two `captureException`s while the migration lasts

`captureException` here takes the tracker's shape on purpose, so finishing the migration is deleting an
import. While both are installed, call both — same error, same context:

```js
import { captureException } from "@downtrace/agent";
import * as Sentry from "@sentry/node";

try {
  await provider.authorize(order);
} catch (err) {
  const context = { stage: "authorize", retryable: true };
  captureException(err, context);
  Sentry.captureException(err, { extra: context });
  return fallback(order);
}
```

Same for the framework's 5xx: register both error handlers, in either order. Both record and then call
`next(err)`, so both see it and neither answers — your own handler still decides the response.

### And when the process dies

A tracker's uncaught-exception integration usually **handles** the exception and then ends the process
itself. This one never does that (see above), so with both installed how your process ends is your
tracker's business: its exit code, its rendering of the crash. What is checked is that adding this
instrumentation changes neither, on either side of the tracker.

## If your application calls `process.exit()`

`process.exit()` is immediate. It does not wait for a promise in flight and it does not fire `beforeExit`,
so an application that calls it the moment its servers close cuts off whatever the instrumentation was
about to send: the interval in hand, the profile of the window, the evidence of a capture. Two lines fix it:

```js
import { shutdown } from "@downtrace/agent";

process.once("SIGTERM", async () => {
  await server.close();
  await shutdown();
  process.exit(0);
});
```

`shutdown()` is safe to call when the instrumentation is off, safe to call twice, and never throws — an
application on its way out has nothing to do with an error from its telemetry.

It waits for the cloud **at most one second in total**: a flush already under way when it is called —the regular
one, or the one a signal started— and then the last batch and the evidence of any capture under way share that
second, one after another. What has not landed when it passes is dropped — the last batch, if the cloud
never answered it, and the evidence of the captures still waiting, which then expire in the cloud unless another
instance of your service delivers them. With `DOWNTRACE_DEBUG=1` the log says which. A signal the instrumentation
handles itself, and the flush when the event loop empties, keep the same second.

You do not need it if you let the process end on its own: closing your servers and letting the event loop
empty is what runs `beforeExit`, and the instrumentation flushes there. Nor do you need it when you only inspect:
with no token and no URL the instrumentation writes what it holds when the process exits (see *What each way of
ending keeps*, above, and *A test run*, below).
