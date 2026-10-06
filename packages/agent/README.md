# @downtrace/agent

> ⚠️ **Not production ready.** Downtrace is a closed free pilot: no plans, no billing and no SLA. The ingestion protocol is `v0` and can still change between minor versions. Install it where a dependency that is still moving is acceptable.

**A flight recorder for your Node.js backend.** Downtrace watches how your application normally behaves and, when something gets slower or breaks, tells you what changed. This is the **instrumentation**: it observes your application from the inside, aggregates locally per route and 10-second interval, and ships compact batches to the Downtrace cloud — never in your request path, never able to throw into your code, with bounded memory.

It observes five things, each of which can be switched off with `DOWNTRACE_INSTRUMENT`:

| Name | What it sees |
|---|---|
| `http` | Incoming requests by route, and outgoing calls by host, with status and duration |
| `pg` | Postgres queries per request, their time and errors, and how long a request waited for a connection; Prisma's too, [where it goes through `pg`](#prisma) |
| `mysql` | MySQL queries per request through `mysql2`, their time and errors, and how long a request waited for a connection |
| `redis` | Redis commands per request, by server |
| `runtime` | Event loop delay, GC pauses, heap, RSS and requests in flight |

It watches only the process it is loaded into: one process, one service.

The package also installs a command, `downtrace`. `downtrace init` configures a project for it, asking nothing and making no network request: see [Configure a project](#configure-a-project-downtrace-init). `downtrace check` compares two runs of your tests, before you deploy, with no account and with nothing leaving your machine: see [Compare two runs before you deploy](#compare-two-runs-before-you-deploy-downtrace-check).

> **On the word «agent».** Two things in Downtrace could be called that, and this README never uses it alone: the **instrumentation** is this library, and a **coding agent** is whoever queries and operates Downtrace — a first-class user of the product, not a part of it. The npm name `@downtrace/agent` keeps the older sense on purpose: renaming a published package costs its users more than the ambiguity costs them, and the ambiguity is bounded by saying which is which everywhere else.

## Install

```sh
npm install @downtrace/agent
```

```sh
DOWNTRACE_TOKEN=dt_… DOWNTRACE_URL=https://your-downtrace-cloud \
  node --import @downtrace/agent/register server.js
# or, without touching the start command:
NODE_OPTIONS="--import @downtrace/agent/register" node server.js
```

| Variable | Required | What it is |
|---|---|---|
| `DOWNTRACE_TOKEN` | yes | The ingest token for this project **and environment** |
| `DOWNTRACE_URL` | yes | Base URL of the cloud, `http://` or `https://`; trailing slashes are ignored |
| `DOWNTRACE_ENV` | no | Environment; falls back to `NODE_ENV`, then `production`. See the note below: a token that belongs to an environment is what decides where the data lands |
| `DOWNTRACE_VERSION` | no | Deployed version or commit; detected from `APP_VERSION`, `GIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `HEROKU_SLUG_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`; else `unknown` |
| `DOWNTRACE_DEBUG` | no | `1` or `true` to log the instrumentation's own activity to stderr |
| `DOWNTRACE_INTERVAL_MS` | no | Aggregation interval in ms (min 1000; default 10000; anything else falls back to the default) |
| `DOWNTRACE_PROFILE_MS` | no | How long a profile window stays open, in ms (default 60000; never below `DOWNTRACE_INTERVAL_MS`, and never above two and a half minutes minus the interval — the floor and the ceiling are derived, see below). Shortening it multiplies the profile rows in proportion, and those count against the project's daily budget |
| `DOWNTRACE_INSTRUMENT` | no | Which observers run: `all` (default), `none`, or a list like `pg,mysql,http,redis,runtime` |
| `DOWNTRACE_SHED` | no | `nothing` (default), `fine` or `profile`: the least the instrumentation gives up, whatever its own meter measures. The benchmark's switch for weighing the fine detail and the profile on their own (ADR 0080, gh-570); leave it alone in production |
| `DOWNTRACE_PG_DEPTH` | no | `full` (default), `context` or `wrapper`: how much of the Postgres observer's attribution runs — `context` attributes the calls and the waits without looking at the query text, `wrapper` only leaves the patch in place. The benchmark's switch for weighing the observer part by part (gh-592); leave it alone in production |
| `DOWNTRACE_QUERY_TEXT` | no | `off` to send query fingerprints without their normalised text. The hash is the identity, so the analysis is unchanged |
| `DOWNTRACE_INSPECT` | no | `stderr` or a file path: writes every batch exactly as it would be sent. With it set, `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` become optional |

An ingest token belongs to one environment, and **that** is the environment everything sent with it is stored as,
whatever `DOWNTRACE_ENV` says. If the two disagree, the data still lands — going blind over a mislabelled deploy
would be worse than the wrong label — and the project's page shows the instance as declaring something else, which
is usually a variable to fix. Tokens minted before per-environment tokens existed are unbound and keep letting the
batch declare.

Without `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` (or with a `DOWNTRACE_URL` that is not `http(s)://`) the instrumentation prints one warning and does nothing else: it loads none of your dependencies and changes none of them — importing the package, or loading it without the token, does not even load Express. So you can add it to a deployment before you have a token: nothing changes until both exist.

## If your build prunes dependencies it cannot see

`--import` loads the instrumentation from the command line, so **nothing in your code imports it**. Bundlers that decide what to ship by tracing imports — Next.js `output: "standalone"`, and anything else that copies "only what is used" — will leave it out. Your dependency is in `package.json`, it is in `node_modules` on your machine, and the container dies at boot:

```
Error: Cannot find package '@downtrace/agent'
```

### Next.js

Use [`instrumentation.ts`](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation), which Next runs once before it serves anything. A few lines, no change to your Dockerfile, no `NODE_OPTIONS`, no change to your start command — and [`downtrace init`](#configure-a-project-downtrace-init) writes them for you when it finds `output: "standalone"`:

```ts
// instrumentation.ts, at the root of your project (or in src/)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@downtrace/agent/register");
  }
}
```

Because your code imports it, Next traces it and ships it. Verified on Next 15 with `output: "standalone"`: the instrumentation starts, finds your `pg` and reports queries per route, and names each route by the file that serves it (`/api/products/[id]`; see Requirements).

The condition is not optional. Next calls `register` in every runtime it builds for, and a project with a `middleware.ts` has the edge runtime too, which cannot load Node's own modules: without the condition, `next build` fails with `Reading from "node:module" is not handled by plugins`. Checked on Next 15.5 with `output: "standalone"`, with a middleware and without one: the hook above builds in both and the built server loads the instrumentation; the same hook without the condition builds only without the middleware.

Your `tsconfig.json` needs `"moduleResolution"` set to `bundler`, `node16` or `nodenext` — the classic `node` setting cannot resolve the `/register` subpath. Next puts one of those in new projects; older ones may still be on `node`.

### Anything else that traces

Either import the instrumentation from an entry point you own, as above, or make the bundler keep it. In Next that is `outputFileTracingIncludes`; other tools have an equivalent.

## Sending no free text at all

`DOWNTRACE_MINIMAL=1` withholds everything you wrote. Route templates, dependency targets, your hostname
and your deployed version travel as stable digests of themselves — same name, same digest, every time, so
the analysis still groups — and query text, the labels of outgoing calls and Redis commands, error messages and
exception signatures do not travel at all. A call's or a command's identity is then a digest of its withheld name.

The digest is of what the route is called. A request that Express or a Koa router answered and no route named is
`(unmatched)`, and nothing of its path enters the digest. For a request that no framework with routes saw, it is the
collapsed route, so a value the heuristic folds — an email, a token, a file name with a number — never enters the
digest. The limit is a plain word in a path of that kind, a name or a slug: the heuristic cannot tell it from the
route's own words, so it enters the digest, and the digest is keyless, which means whoever guesses the word can
confirm it. An endpoint exclusion keeps it out entirely, because excluding is not observing.

What stays is what is not yours: the protocol version, the agent's own name, the HTTP method, the kind of
each dependency, the counts and the timings. Downtrace keeps detecting and comparing; what it loses is the
ability to **name** anything, and it says so in every report rather than showing you a bare hash.

The environment is not withheld: your ingest token already tells the cloud which one it is, so hiding it
here would protect nothing and would collapse the per-environment scope everything is organised by.

`DOWNTRACE_QUERY_TEXT=off` still exists and still does the smaller thing: send the routes, not the queries.
It is about queries, so it does not touch the context of an error you report.

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
measure users (IMP-01), and this call cannot enforce that on prose you wrote.

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
| `process.exit()`, without waiting, **inspecting with no cloud** (below) | everything it was holding, written on `exit` with `ending: "exit"` (`exit.test.ts`) | nothing it was holding |
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
keep. It is why a short run that ends with an explicit exit keeps its profile (*A test run*, below), and it has two
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

**Either order is exact.** Both instrumentations end up wrapping the same `pg` prototype, and this one no
longer loads the driver at start-up: it resolves it from your application's root (with no loader hooks,
which is what lets it work without you importing anything) and patches it from the first request at which
your application has loaded it — a cache hit that re-executes nothing. So whichever order the two are
loaded in, your application's own load of `pg` is the only one the tracker's hooks ever see, and each one
observes what it would alone: same requests, calls per request and errors on this side, and the tracker's
own `pg` spans on its side — one `pg-pool.connect` and one query span per request, with no duplicates. A
test runs the three configurations — each one alone, and both in each order — against one another.

**The one thing it gives up is said here, not found.** If your application loads `pg` lazily — an
`import("pg")` inside a handler — the queries of the request that loads it for the first time are not
counted; from the next request they are. An application that imports `pg` where it imports the rest loses
nothing.

**That was verified with an ESM application.** A CommonJS application shares the module cache the same
way, but the tracker's hooks only fire on a real load there, so whether its `pg` spans survive is a matter
of its own load order; it is not verified, so if your application is CommonJS and you care about your
tracker's `pg` spans while both are installed, check them.

Everything else composes cleanly, in both orders, and there is a test that compares exact counts —
requests, calls per request, errors — against each one running alone:

- **What this instrumentation reports does not change**: same requests per route, same queries, Redis
  operations and outgoing calls per request, same errors, whether the tracker is there or not.
- **Its own cost does not change either**: no internal errors, and the meter never has to give anything up.
  The hook time it reports is sampled inside its own hooks, so your tracker's work is never counted as ours.
- **Your tracker's ingestion is not reported as one of your dependencies.** It sends outside the request
  that produced what it is sending, so there is no request to charge it to.

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

## What leaves your server

Only structural metadata: method, **route template** (`/products/:id`, never the actual URL), status, counts and a fixed-bucket latency histogram per route and interval, plus the process identity (random id, hostname, pid) and the deploy (version, environment). No bodies, no headers, no query strings. The exact contract is the JSON Schema in [`@downtrace/protocol`](https://www.npmjs.com/package/@downtrace/protocol).

That is what goes out every ten seconds. Three other things can leave, and they are listed here rather than left for
somebody to find in a schema: **the detail of a capture**, **reference samples** and **the instrumentation's own
resources**. Each has its own section below. None of them carries a value from your database, a body, a header or a
URL — the same rule as the aggregates, and `DOWNTRACE_INSPECT` shows you all of it.

### The health of your process

Every interval the instrumentation also reports how late Node's event loop ran (median, p99 and worst), how much time went to
garbage collection, heap and resident memory, and the peak number of requests in flight. In Node many slowdowns are
neither the database nor the network but the process itself, and a diagnosis that does not measure it will blame
whatever it does measure. It all comes from Node's own instruments, which run whether anyone looks at them or not.

### Database work per request

When your application uses `pg`, the instrumentation also counts the calls each request makes to it, how long they took in
total, the slowest one and how many failed, and reports that distribution per route. It also times how long each
request **waited for a connection** from the pool. That wait is not the database being slow, it is your application
having nowhere to run, and it is invisible in the query's own duration. A wait that ends without a connection — the
pool timed out, or the database refused — is counted too, on the same database as the connections that pool handed
over, or on the host and port of its connection string when it has handed none: a pool run dry is one dependency
saturated, not a nameless one. The connection string gives only its host and port, never its user, password or
database. It is what turns "this endpoint
got slower" into "this endpoint went from 12 queries per request to 65". **It never reads the query text or its
values**, only counts and durations.

A query counts for the request whose code ran it, and for no other. One that runs outside any request — a
migration at start-up, a scheduled job, a health check's poll, work a handler left for later — is in no route's
numbers, because no route ran it. A request answered before it reached the database — a gate that says «starting
up», a rate limiter's 429, a 401 for a missing session — carries no Postgres at all, because it made no call. So a
route with Postgres in one interval and none in the next has not lost its queries: its requests ran none inside
the request, which does not mean the database was idle. Checked against n8n with every statement logged by
Postgres: each request carried the queries the log shows for it, and the ones n8n answered without its database
carried none.

### MySQL

When your application uses `mysql2`, the instrumentation does the same for MySQL, as a dependency of its own
(`mysql`): the queries each request makes, how long they took, how many failed, and how long the request waited
for a connection from a `mysql2` pool, apart from the query that followed it. TypeORM, Sequelize and knex — which
is what Strapi uses — reach MySQL through `mysql2`, so they are observed through it; nothing is asked of them.
The target is the host and the port of the server (the socket path, for a socket), never the user, the password
or the database. Prepared statements (`execute`) count like queries.

**The query text is read as MySQL's, not as Postgres'.** In MySQL, without `ANSI_QUOTES`, a double quote opens a
*string*, where in Postgres it opens a name: `WHERE name = "ana"` has a value in it, and it is replaced like any
other (`WHERE name = ?`). A backtick opens a name, which stays: `` SELECT `name` FROM `users` `` travels as it is.
The rest of MySQL's lexical rules are the server's: a backslash escapes in a string, `#` and `-- ` open a comment,
`/* */` does not nest, and a `$` is a letter of a name. What the scanner cannot read with confidence is omitted
and not guessed: a `--` not followed by a blank, a comment opened with `/*!` (the server runs what is inside), a
block comment that opens another, a delimiter that never closes. Such a query travels as its hash and its class
(`select`, `insert`, …) and no text. A server in `ANSI_QUOTES` mode gets a poorer label — its double-quoted names
read as values — and nothing leaves.

What the instrumentation does with the driver, and what it gives up:

- **A query belongs to the request whose code ran it.** `mysql2` finishes a query on the connection's socket, in
  the async context of whichever request opened that connection, and its callback API is built on callbacks: the
  second query of a chain is asked from inside the first one's. So the context is taken when the application
  asks, the result is written into it, and the application's callback runs with it. That changes the one thing
  this instrumentation keeps in async storage and nothing of the application's own.
- **It wraps the methods that define `query`, `execute` and the pool's `getConnection`** — on the class `mysql2`
  defines them on, so a pool's connections are covered whichever way the version lays its classes out (up to 3.18 a
  pooled connection is not a `Connection`). Run against a MySQL 8.4 server, with every way of asking for a query, on
  2.3.3, 3.0.0, 3.2.0, 3.6.5, 3.9.8, 3.10.3, 3.11.5, 3.14.5, 3.19.1, 3.20.0 and 3.24.5. Arguments, results and
  errors pass through untouched, and if the wrapper itself fails the query still runs. It never asks a query for a
  result: `mysql2`'s commands throw when they are awaited.
- **The wait is the wait of `mysql2`'s own pool.** knex and Sequelize keep a pool of their own over plain
  connections, and a request that queues in it is not seen waiting. The wait of a MySQL pool travels with the
  dependency's aggregate, which is what a pool-saturation finding reads; it is **not** part of the wait that goes
  with a capture's requests, which is Postgres' (a finding over a MySQL pool gets no estimate of its impact, and
  says so).
- **A query run with listeners or as a stream** (`connection.query(sql).on("result", …)`) has no callback to
  settle: it is counted when it is issued, with no time and no failure, as a `pg` cursor is. Prepared statements
  made with `connection.prepare()` and run through the statement are not observed.
- **Beside an error tracker** this was not verified for `mysql2`, as it was for `pg` and `ioredis`
  ([below](#beside-your-error-tracker)): the mechanism is the same — it resolves the driver and loads nothing — but
  nobody has run the pair.

### Prisma

Prisma is observed when it reaches Postgres through `pg`, and only then. What decides it is not the version of the ORM
but the engine that runs its queries, so it was measured, version by version, with this instrumentation loaded through
`--import` and a real Postgres 17 behind it (Prisma 5.22.0, 6.7.0, 6.16.0, 6.19.3 and 7.10.0):

| Your Prisma | Its queries go | Observed |
|---|---|---|
| 7.x, with `@prisma/adapter-pg` | through `pg`: 7 has no engine of its own and requires an adapter | **Yes** |
| 6.16 and later with `engineType = "client"` in the schema's generator (6.7 to 6.15: the `queryCompiler` preview), with `@prisma/adapter-pg` | through `pg`, as 7 does | **Yes** |
| 5.x, and 6.x on its default engine, with `@prisma/adapter-pg` | from Prisma's query engine, which calls the adapter, and so `pg`, from a thread of its own | **No** |
| 5.x, and 6.x on its default engine, with no adapter: what Prisma 5 does unless told otherwise | from the query engine, which speaks to Postgres itself and never touches `pg` | **No** |
| Any version with another adapter (Neon, MariaDB, …) | through that adapter's own driver | **No**: it was not looked at |

When it is observed, nothing is asked of you: a Prisma query is a query of the route that ran it, with its time and its
errors, and its fingerprint in the route's profile, like any `pg` query. The queries of `prisma.$transaction` carry the
`BEGIN` and the `COMMIT` that Prisma sends, because they are queries. Prisma sends its values as parameters, so what a
`findMany({ where: { name } })` is called is `… WHERE "public"."User"."name" = ? OFFSET ?`; SQL that you write yourself with
a value in it (`$queryRawUnsafe`) is normalised like any other, and the value does not leave. Prisma merges calls to
`findUnique` of the same shape made in the same tick into one query (`WHERE "id" IN (…)`), and that query is counted
once, for the request whose call came first: measured on 7.10.0, four requests that asked for the same row in one tick
made one query.

To be observed, then: Prisma 7, or on 6.16 or later `engineType = "client"` in the generator block of the schema, and
the adapter. No tracing and no OpenTelemetry are involved:

```ts
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
```

How to tell which row you are in: with `DOWNTRACE_INSPECT`, a route whose Prisma queries are seen has a `postgres`
dependency. A route that queries through Prisma and has none is in one of the **No** rows, and is not a route that makes no
queries.

**Why the engine's queries are not seen.** With an adapter, the engine calls it from a thread of its own, so the query
reaches `pg` carrying none of the request's async context: `pg` sees every query, outside any request, and a query
outside a request counts for no route. The instrumentation counts a query for the request whose code ran it and never
guesses which one that was. The versions that run their queries in JavaScript run them in the context of the call that
asked: with four concurrent requests, every query came to the request that made it. Without an adapter, there is nothing to
see through `pg` at all.

**What could be seen, and is not asked for.** Prisma's engine can report each query as a trace span, and what it looks for
in order to do it is an object on `globalThis`, so it can be read without loading OpenTelemetry into your application. The
instrumentation does not switch it on, because the engine only produces those spans when asked to, and asking has a price
that was measured against the same Postgres on the same machine: a query went from 0.38 ms to 0.46 ms, about a fifth more,
and the process used about 15 points more CPU while queries ran back to back; and Prisma appends a comment with the trace's
identity to every statement it sends. A request that runs twelve queries would spend on that the millisecond that is the
whole budget (see Guarantees). On 5.x it also needs `previewFeatures = ["tracing"]` in your schema. It is a decision
this README does not take for you.

**The `pg` the adapter uses.** From 6.11, `@prisma/adapter-pg` has `pg` as a dependency of its own and not as a peer (in 5.x and up to 6.10 it was one), and the
copy it queries through is not always yours: with pnpm, an application that lists the adapter and not `pg` has none at its
root, and with npm a `pg` of yours that the adapter's version range does not take is a second copy beside it. So the
instrumentation also resolves the `pg` that `@prisma/adapter-pg` resolves, without loading it, and patches it when the
application has: a query is counted by the copy it went through, once.

### Calls to other services

Outgoing HTTP is reported the same way, grouped by the host your application asked for: how many calls per request,
how long they took, the slowest one, and how many failed. A 5xx from a dependency counts as a failure of that
dependency, because for "is this service degraded?" a 500 and a timeout are the same answer.

`fetch` and the `node:http` client both publish on Node's `diagnostics_channel`, and the instrumentation listens. There is one
exception: when a `fetch` cannot connect at all, undici publishes nothing, and that is exactly the case where a
dependency is down. For that, and only that, the instrumentation wraps `globalThis.fetch`: if a call rejects and nothing was
recorded for it, it counts as a failed call. On every other path the wrapper does nothing.

Each call is also an **operation** of the route that made it, beside its counter: in the route's profile and in the
black box, with when it started and when it ended. It is named by its method and the host it asked for —
`POST api.stripe.com` — and never by its path or its query string. Two calls to the same provider that overlapped are
two operations that overlap in a capture, which is what tells «three calls one after another» from «three calls at
once». The name is made once per method and host and kept, so a call costs a lookup, not a hash.

### Redis

The commands each request issues are reported the same way, per server: how many per request, how long they took and
how many failed. ioredis publishes on a tracing channel, so nothing is patched.

Each command is also an **operation**, in the profile and in the black box, named by the command and its server —
`HGETALL cache:6379` — and never by its key or its arguments, which ioredis puts on the channel and the
instrumentation does not read. A Redis reached through a unix socket has a path for its server, which no label may
carry, so its commands travel with their hash alone; a command the channel does not name is counted and is not an
operation.

Every dependency carries a **target** saying which instance of its kind it is, taken from the driver: the host for
outgoing HTTP, host and port for Postgres, MySQL and Redis. A read replica and a primary are two dependencies, not one.

The first 60 distinct destinations a route talks to in an interval keep their target; past that, the rest fold into
one row of their own kind with target `(other)`. The folded destinations' calls, time and errors are in that row —
summed per request, so a request that talked to three of them counts once — and nothing of them is dropped. The cap
is there because a batch the schema refuses is dropped whole, and it would be the interval of every route, not only
the one that went past.

The instrumentation loads before your application (`node --import`), so it wraps the driver before you import it and you write
no code. The wrapper passes arguments, results and errors through untouched, and a failure inside it runs your query
anyway. `DOWNTRACE_INSTRUMENT=none` turns it off.

### What each route normally runs

The instrumentation also builds a **profile**: not only that a route made 4 queries, but which ones — and which
outgoing calls and Redis commands it made, as above.
Each query text is reduced to its shape — `SELECT id FROM products WHERE id = ?` — and hashed, read as the SQL of the
database it was sent to. The hash is the
identity the cloud groups and compares by; the text is only the label you read. That is what lets Downtrace say
*«this route went from 2 executions of this query to 53»* instead of *«this route makes more queries now»*.

The profile goes out **once a minute**, separately from the 10-second aggregates, because what a route runs
changes when your code changes, not every ten seconds. The minute is the default; `DOWNTRACE_PROFILE_MS`
moves it, between a floor and a ceiling, and both are derived rather than chosen:

- **The floor is the interval.** A profile window closes on the first flush after it is full, and the flushes
  come every interval. A window shorter than the interval that feeds it closes on the very same flush as one
  equal to it, so below `DOWNTRACE_INTERVAL_MS` the number stops meaning anything.
- **The ceiling is two and a half minutes minus the interval.** It is derived from the window that reads the
  profile: the report's diff reads the recent window as the last five minutes, ending one minute ago — the
  minute being the arrival budget, what is flushed by then has arrived by the check — and it counts a profile
  window on the side where it *starts*. A window is only in the store once it has closed and been flushed,
  which is the first flush after it is full, at most one interval later. For the five minutes to hold a
  profile that has arrived **at every phase**, two whole windows, each with its flush, must fit in them:
  twice (profile + interval) ≤ five minutes. Above the ceiling there are phases in which the report's window
  holds no profile that has arrived, whatever the instrumentation is sent, and the report then says
  `no-profile-after` of a route that was profiled as asked.

A value below the floor is taken as the floor without saying anything, because that is a no-op; a value above
the ceiling is clamped to it and said once at start-up, because that is not a no-op: the cadence in effect is
not the one you wrote, and the profile rows you pay are not the ones you asked for.

**No value from your database ever leaves your server.** Literals, parameters, quoted bodies and comments are
replaced before anything is stored or sent, and that happens in your process, not ours. If you would still rather
not send the query text at all, `DOWNTRACE_QUERY_TEXT=off` suppresses it — with every other label of the profile,
the calls' and the commands' included — and changes nothing else: the hash is the identity, so you keep the whole
analysis and only lose the readable label.

### When someone asks for detail: a capture

The instrumentation keeps a **black box** in memory: the last tens of seconds request by request, with the operations each
one ran and when each started and finished, plus a coarser summary of the last few minutes. Nothing of it leaves your
server on its own. It leaves when a capture asks for it — and a capture is asked for in one of two ways: the cloud asks,
in the answer to a batch, or **the instrumentation asks for one itself** when a local signal says the process is in
trouble (today: the event loop running more than 250 ms late, at the p99, for two intervals in a row).

What travels then is the same kind of thing as an aggregate, one level finer: for each request, its **route template**,
method, status, when it started and how long it took, and the operations it ran as **hashes** with their kind — a
query, a call, a command, or an error beside them — and their starts and ends.
Never the query text, never a value, never a path. Order and overlap are the whole point — they are what separates «this
request spent 400 ms waiting on the database» from «it ran three queries at once».

Beside it goes the **coarse summary of the last few minutes**: per endpoint, second by second, how many requests, how many
failed, how long they took in total and at the worst, how many database calls they made — and the process's own event loop
delay as a series of its own, since a slow loop belongs to no endpoint. The fine detail says what the captured requests
did; the summary says what the rest of the process was doing around them, which is what makes a degradation that was
detected late readable as a beginning. A quiet second travels as zeros; a second nobody watched travels as absent — the
cloud can tell the two apart, and so can you.

It also says what it could **not** give you: how many requests it observed from the moment it started watching, how many
it attached from detail it still had, and how many lost their detail before it could be read. A capture that saw nothing
sends an empty answer rather than silence.

### A few requests to compare against: reference samples

A capture of what went wrong is worth little without something to compare it with, and the fine detail of an hour ago no
longer exists. So the instrumentation keeps a handful of requests per endpoint — a **uniform reservoir**, so every request
has the same chance of being kept, whatever it did — and sends them with a capture, saying how they were chosen. They have
exactly the same shape as the captured requests, and the same rule: hashes, never text.

### What the instrumentation itself costs

Every batch can carry what the instrumentation is spending and losing: batches it dropped because its queue was full,
batches the cloud refused, batches it could not send, errors inside itself, the memory its registers hold and an
**estimate** of its own hook time per request. Numbers about the library, not about your application — and the reason they
travel is that a cloud seeing nothing has to be able to tell «nothing happened» from «this instrumentation has been
throwing batches away for two hours».

## See exactly what would leave your server

You do not have to take our word for it, and you do not need an account:

```sh
DOWNTRACE_INSPECT=./downtrace-batches.jsonl node --import @downtrace/agent/register app.js
```

That is the whole setup. No token, no URL, nothing sent anywhere. Your application runs instrumented, and every
batch it *would* have shipped is appended to that file — the **exact bytes**, one JSON line each. Drive some real
traffic through it and read what comes out:

```sh
# every route template it discovered
jq -r '.intervals[].endpoints[].route' downtrace-batches.jsonl | sort -u

# every query fingerprint, as it would travel
jq -r '.profile.endpoints[]?.operations[]? | "\(.hash)  \(.text // "(no text)")"' downtrace-batches.jsonl

# and the question that actually matters: is anything of yours in there?
grep -i 'algo-que-no-deberia-salir' downtrace-batches.jsonl
```

It works with a cloud too. Set `DOWNTRACE_INSPECT` alongside your token and URL and it writes **and** sends, so a
running deployment can be audited without turning it off, and what you read is what actually went out.

Two things worth knowing: **the file grows and nothing rotates it** — it is yours, and so is deciding what to do
with it — and it may contain the normalised text of your queries, which is the point, so give it the same care
you would give an application log.

### A test run: what each runner keeps of its profile

A profile covers a minute and a test run lasts seconds, so what a run keeps of its profile is what each process hands
over as it ends, and how a process ends is the runner's doing and not your application's. To profile a run, load the
instrumentation into **every** process the runner starts, and name a file:

```sh
DOWNTRACE_INSPECT=./downtrace-run.jsonl NODE_OPTIONS="--import @downtrace/agent/register" npx vitest run
```

`NODE_OPTIONS` is inherited by every process and thread a runner starts. `--import` on the command line is not: a
runner decides which of its own flags it passes on, and Vitest's workers do not get it, so a run started with
`node --import @downtrace/agent/register node_modules/vitest/vitest.mjs run` is observed in the process that started
it and in none that ran a test (by hand, on Vitest 4.1.11; `node --test` and Mocha's workers do get it). With no token
and no URL nothing leaves the machine, and each process writes what it holds as it ends — on `exit` too, so a runner
that ends a process with `process.exit()` and waits for nothing loses nothing. What each runner does, and what the
file holds when the run is over:

| Runner | How it ends the processes its tests ran in | The profile of every route the tests called |
| --- | --- | --- |
| Vitest, `forks` pool (the default) | a signal, which the instrumentation's own handler answers | kept (`runners.test.ts`) |
| Vitest, `threads` or `vmThreads` pool | terminates the thread, and a terminated thread runs nothing | **lost** (`runners.test.ts`) |
| `node --test` | each file's process ends when its loop empties | kept (`runners.test.ts`) |
| `node --test --test-force-exit` | `process.exit()` | kept, written on `exit` (`runners.test.ts`) |
| Jest — in band, in workers or in worker threads, with or without `--forceExit` | workers end on their own; in band, `--forceExit` ends the process with `process.exit()` | kept, written on `exit` when forced — **by hand** |
| Mocha — default, `--exit` or `--parallel` | ends on its own; `--exit` and the workers of `--parallel` end with `process.exit()` | kept, written on `exit` when it exits — **by hand** |

The rows with a test were run by the real runner, Vitest 4.1.11 on Node 24. The two marked **by hand** were run once,
against Jest 30.5.2 and Mocha 12.0.3 on Node 24, and no test asserts them: adding either to this package so that a
sentence has a test would be a dependency whose only use is to be run here. Also by hand, on Vitest 4.1.11, its `vmForks`
pool and `--no-isolate` behave as the `forks` row says and its `vmThreads` pool as the `threads` row does; and Vitest
5.0.3 behaves as 4.1.11 in the default pool and in `threads`.

**Vitest's thread pools are the one case that loses it, and nothing in a thread can change that.** A terminated thread
fires no `beforeExit`, no `exit` and no signal: what it held goes with it, and the file does not have its routes. Use
the `forks` pool, which is the default. If you need threads, end each test file with `await shutdown()` from a setup
file — `afterAll(() => shutdown())` — and the thread hands over before it is terminated. That works with isolated
threads, a thread per file, which is Vitest's default for the pool; in a thread that runs more than one file only the
first is observed, because `shutdown()` stops the observation. Checked by hand against the built package, not by a
test.

Three things about reading the file. It is written by every process, not only the ones that ran tests: a helper process
a runner starts that ended in order writes one batch with no interval and only its `ending`, and you can ignore it. A
route is in a profile only when it ran something — a query, an outgoing call, a Redis command or an error — so a route
that ran nothing is in the aggregates and has no profile at all. And a profile that never arrived, like the one of a
terminated thread, is not an empty one: the file does not say it was lost, so a route you cannot find in it is a route
you did not observe, never a route that did not change.

## Configure a project: `downtrace init`

```sh
npx @downtrace/agent init
```

It reads the project in the directory it runs in — its `package.json`, the lockfile beside it (or above it, up to the top of its git repository, where a workspace keeps the one lockfile), its `next.config` and its `tsconfig.json` — and writes what the project needs. It asks for no token and no URL, asks no question, and makes no network request: locally there is no cloud. Installed with the project, `npx downtrace init` is the same command; where `@downtrace/agent` is not installed, `npx downtrace` is not (see [`downtrace check`](#compare-two-runs-before-you-deploy-downtrace-check)), and every command `init` prints is spelled for whether the project has the package.

| It looks for | Where | What it does with it |
|---|---|---|
| The test command | `scripts` of `package.json`: the first of `test:integration`, `test-integration`, `test:int`, `integration` and `test`, and npm's «no test specified» placeholder is no test | writes it to `downtrace.json` as `check.command`, run by the package manager that `packageManager` names or the lockfile is of — `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `bun.lockb`, `package-lock.json` or `npm-shrinkwrap.json` — and npm without one: `npm run test:integration`, `pnpm test` |
| A framework whose routes are named by their templates | `express`, `koa`, `@strapi/strapi` (which runs on Koa) or `next` among the dependencies | says which |
| What the instrumentation observes inside a request | `pg`, `@prisma/adapter-pg`, `mysql2` and `ioredis` among the dependencies; outgoing HTTP always | says which |
| A build that prunes what nothing imports | Next.js with `output: "standalone"` in `next.config` | writes [the hook above](#nextjs), in `src/` when the application is there, and as `instrumentation.js` in a project with no `tsconfig.json` |

An integration suite comes before the unit one because `check` judges what each request ran: a run whose database is simulated observes nothing, and its routes are not evaluated. `init` installs nothing, changes neither `package.json` nor your start command, and does not write `routes`: which routes the project has is in its code, and declaring them is yours (below).

**Run it again whenever you like.** It writes `check.command` only where there is none: a `downtrace.json` that has one is left as it is, byte for byte, and one without it gets the command and keeps every other key, inside `check` and outside it. The hook is written only where the project has no `instrumentation` file at the root or in `src/`.

When something cannot be detected or done, it says what and what to do instead, writes what it could, and ends with 1:

| Code | What it means, and what to do |
|---|---|
| no-package-json | There is no `package.json` where it runs: run it at the root of the Node.js project, and in a monorepo in the directory of the service. |
| no-framework | None of the frameworks above. In a monorepo, run it in the directory of the service. Elsewhere `check` still compares the runs: the instrumentation observes every request through `node:http` and names its route by the shape of its path (see Requirements). |
| no-test-command | None of the scripts above. Give `check` a command that sends requests to the routes with their real dependencies: a test script, or a walk of the routes — a script that starts the application, sends a request to each route and stops it — in `downtrace.json` or after `--`. |
| not-a-repository | No git repository holds the project, and `check` compares the working tree against a commit. |
| not-installed | The build prunes and `@downtrace/agent` is not a dependency, so a hook that imports it would break the build: install it and run `npx downtrace init` again. |
| instrumentation-exists | The project has a hook that does not load the instrumentation. It is not touched; add the `if` and its `import` above inside its `register()`. |
| module-resolution | `tsconfig.json` sets `moduleResolution` to `node`, `node10` or `classic`, which cannot resolve `@downtrace/agent/register`: set it to `bundler`, `node16` or `nodenext`, and run it again. |

The exit status: **0 configured**, **1 something could not be detected or done**, **2 a file it reads could not be read** — a `package.json` that is not JSON or not shaped as one (`bad-package-json`), a `downtrace.json` that `check` would refuse (`bad-config`; it is the person's, and not rewritten), or a file the system would not give (`io-error`) — and nothing was written. `--json` prints one object for a coding agent, `schema: "downtrace-init/1"`: `status` (`configured`, `incomplete` or `failed`), `project`, `detected` (the package manager, the frameworks, the observed packages, the test script and its command, and `bundler`), `command` (what `check` runs now: the one `init` wrote, or the one a person had put there), `files` (each `created`, `updated` or `unchanged`), `missing` (each with a `code`, a `message` and `advice`), `failure`, and `next`, the command to run next.

## Compare two runs before you deploy: `downtrace check`

```sh
npx downtrace check --base origin/main -- npm test
```

It runs your tests twice — on the base you name, in a temporary checkout of its own, and on your working tree as it is — with the instrumentation writing locally, and compares the two route by route **by composition**: which queries, outgoing calls and Redis commands each request ran, by fingerprint, and how many times. For each route it says one of three things:

- **worse**: an operation appeared that the base did not run, or one runs at least 25% and at least half an execution more per request than it did. It names the operation by its fingerprint and says how many times a request ran it.
- **unchanged**: the route was evaluated and nothing of that kind got worse. An operation that is gone or runs less is listed, and is not worse.
- **not evaluated**: the run cannot say, and says why. A route is never presented as unchanged because nothing was looked at.

It needs no account and sends nothing anywhere: the runs are given no token and no URL, so the instrumentation can only write a file, and `git` runs with no hook of yours, no LFS download and no password prompt. It never checks out, stashes or resets anything in your working tree; the base is a worktree under your temporary directory, outside the repository, that is removed when the runs end, however they ended. Installed with the project, `npx downtrace check` finds this package's command; where `@downtrace/agent` is not installed, `npx @downtrace/agent check` is the same command, and `npx downtrace` is not: it would look for a package of that name on the registry, which is not ours. It is tried on macOS and Linux, and its test command is run by a POSIX shell.

### What it answers, and what it does not

**Composition, never latency.** Durations are shown beside each verdict as data — the mean time of a request, the time per execution of an operation — and no verdict depends on one: the traffic of a test run is not production's and the machine it runs on is not quiet. The comparison is per request, so more traffic through the same code is not a regression. What a small fixture shows is the operation that appeared and how many times it repeats — five executions where production would see fifty — and that is what it names.

**What it says nothing about** is what only real traffic produces: a dependency that degrades, a pool that saturates, a change of load, an error that depends on production's data. The errors beside the operations are not judged either; the test command's own result is where a failing test shows. Those are what production is for.

**Operations are the same operation by fingerprint**, with one exception made for your machine: a call or a command to `localhost`, `127.0.0.1` or `[::1]` is the same operation whatever its port, because a test's stub server on a port the system picks has another port on every run and would otherwise be an operation that appeared beside one that vanished. A bucket of requests that belongs to no route of yours is not judged at all (below).

### Why a route was not evaluated

Each route that is not evaluated carries a code an agent can branch on, in the JSON, and a sentence in the text:

| Code | Why |
|---|---|
| `not-called` | No request reached it in either run. Only a route your project declares (`routes`, below) can be named when nobody called it: nothing observes a route nobody asked. |
| `not-called-in-base` | The base run made no request to it: it is new, or the tests only reach it now. |
| `not-called-in-change` | The change run made no request to it: it is gone, or the tests no longer reach it. |
| `no-profile-in-base`, `no-profile-in-change` | That run saw requests to it and no profile covered them, so what they ran is unknown. |
| `nothing-observed` | No query, outgoing call or Redis command was observed inside its requests, in either run: it has none, or its dependencies were simulated or are not observed. With nothing to compare, nothing is said; a route that starts running something in the change is not this, it is worse. |
| `bucket` | A bucket of requests, not a route of the project: `(unmatched)` is what no route of the framework matched, `/_not-found` is Next.js's own, and `(other)` is what went past the cap of routes. What is in one is a mix and how many requests fall in it depends on the tests, so a bucket is listed by name and never judged, and a change in how many fall in it is never read as a route getting worse. |

If **no route** could be evaluated, `check` does not print a green result: it says no comparison could be made and lists why each route was not evaluated.

### When a run leaves no profile

The instrumentation writes what it holds when its process ends, in an orderly way or on `exit`, and after every second of the runs `check` makes, so a runner that ends its processes with `process.exit()` — `node --test --test-force-exit`, Jest `--forceExit`, Mocha `--exit` or `--parallel` — keeps its profile (*A test run*, above). What can still lose it is a runner that stops the threads that run the tests: a terminated thread runs nothing, and nothing in it can write. The file does not say that anything was lost — a process that wrote nothing looks like one that served nothing — so `check` reads the command it ran. When a run left no profile it says «the run left no profile», names the cause it can tell from the command, and says what to use instead:

| In the test command | Use |
|---|---|
| Vitest with the `threads` or `vmThreads` pool | use `--pool=forks`, which is Vitest's default |

The instrumentation is loaded into every process of the run through `NODE_OPTIONS`, and not with `--import` on the runner's command line: a runner's workers do not inherit the command line (Vitest's do not), and `NODE_OPTIONS` reaches every process. Every process writes its own lines into one file, so `check` merges them by route and counts a window or an interval that was written twice once. A route whose requests made calls that no profile covers is evaluated over the requests that a profile does cover, and the report says how many that was; one with none is `no-profile-in-base` or `no-profile-in-change`.

### The test command and the configuration

The command comes after `--`, or from `downtrace.json`, which `downtrace init` writes for `check` to read. It lives at the root of the project or of the repository, and is looked for upward from where `check` runs:

```json
{
  "check": {
    "command": "npm test",
    "routes": ["GET /products", "POST /checkout"],
    "prepare": "pnpm install --offline --frozen-lockfile",
    "timeout": 900
  }
}
```

Every key is optional. A key `check` does not know is an error, and keys outside `check` are not judged.

| Key | What it is |
|---|---|
| `command` | The test command, run by a shell; or a list of words, which is quoted for it. A command after `--` takes its place. |
| `routes` | The routes the project has, as `METHOD /template`, so that one no test calls can be named as `not-called`. The template is the one the instrumentation names the route by: `/products/:id` for Express and Koa, `/products/[id]` for Next.js. |
| `prepare` | A command run in the base checkout before the tests, for what a fresh checkout lacks. When it is given, the base's dependencies are its business, and `check` links none (below). It gets `DOWNTRACE_CHECK_ORIGIN`, the directory of your project. |
| `timeout` | How long each run of the test command may take, in seconds; 900 by default, `--timeout` on the command line. A run that does not end in time is stopped, with what it started, and said. |

Options of the command: `--base <ref>` (what to compare against; `HEAD` by default, which is what is not committed yet; for a branch that is behind its base, `$(git merge-base origin/main HEAD)`), `--json`, `--config <file>`, `--timeout <seconds>`. The progress of a run goes to stderr, so that stdout is the result alone.

**How the base runs.** A fresh checkout has no dependencies, and installing them would need the network, so every `node_modules` of your working tree (to three levels below the top of the repository) is linked into the same place in the base. Two consequences are yours to know: a tool that writes into `node_modules` writes into yours — `check` installs nothing itself, and sets `verify-deps-before-run=false` for the base so that pnpm does not install on its own — and a package of your own repository that is linked into them is the working tree's, not the base's: in a monorepo, run `check` in the package that changes, or give `prepare` the install that builds the base's own. Files git ignores, a `.env` for instance, are not in the base; `prepare` can copy them from `DOWNTRACE_CHECK_ORIGIN`. The checkout runs no hook of the project, fetches no LFS object and does not initialise submodules. If `check` is killed without the chance to clean up (`SIGKILL`), the temporary checkout stays under the temporary directory, and `git worktree prune` takes its entry away. Every `DOWNTRACE_` variable of your environment is dropped for the runs: they would point the instrumentation at production.

### What it hands back

For a person, text with the three columns, each route with its evidence. For a coding agent, `--json`: one object, `schema: "downtrace-check/1"`, with `status` (`compared` or `failed`), `summary` (`worse`, `unchanged`, `notEvaluated`), `base` and `change` (the ref, the commit, the command, its exit status and what the run left: processes, requests, routes, profile windows, lines it could not read, what each observer said), `notes`, and `routes`. Each route has a stable `id` (`POST /checkout`), its `verdict`, its `reasons` when it was not evaluated, `requests` and `profiledRequests` for each side, `meanRequestMs`, its `dependencies` (all the queries, all the outgoing calls, all the commands, per request, on each side) and its `operations`: for each, a stable `id`, the `hash` of its fingerprint, its `kind`, its `label`, how it moved (`appeared`, `multiplied`, `unchanged`, `reduced`, `disappeared`), and `perRequest`, `executions` and `msPerExecution` for each side. A comparison that could not be made has `status: "failed"` and a `failure` with a `code`, the `side`, a `message`, `advice` and the `outputTail` of the command when it is what failed: `not-a-repository`, `bad-ref`, `bad-config`, `no-command`, `setup-failed`, `command-failed`, `timeout`, `no-profile`, `nothing-evaluated`, `interrupted`.

For CI, the exit status: **0** no route got worse, **1** at least one did, **2** no comparison could be made — the test command failed on either side (a comparison needs two runs that end well), a run left no profile, no route could be evaluated, or the command was interrupted.

## Guarantees

- HTTP requests are observed through Node's `diagnostics_channel`, without touching your code. To count queries per
  request the instrumentation does wrap one method, `pg`'s `Client.prototype.query` (and, for MySQL, `mysql2`'s `query` and
  `execute`): it passes arguments, results and errors through untouched, and if the wrapper itself fails your query still
  runs. `DOWNTRACE_INSTRUMENT=none` disables it.
- For Express route templates the instrumentation wraps two more methods. The first — `Router.prototype.use`, or the
  `Router` function's own `use` in Express 4, where it is the routers' prototype — keeps the pattern of
  each mount, because Express discards it as soon as it compiles it: without the pattern, a mount with a
  parameter would reach the template as its value. The second — `Route.prototype.dispatch` — keeps the mount a
  matched route saw, because Express restores `req.baseUrl` before an app-level error handler answers, so without
  it a 5xx would reach the template with the wrong mount. Both wrappers are put in place when the instrumentation
  **starts** — with `--import`, before your application registers anything — and not when the package is imported: an
  import with the instrumentation not running loads no Express and touches nothing. They pass arguments, results and
  errors through untouched, and a failure inside either one runs your application anyway — the mount is then read as
  `:param`, which is the safe side (see Requirements).
- For Koa route templates the instrumentation wraps one more method, `Application.prototype.createContext`, which builds the
  context of each request: it remembers which context belongs to which request, because the template a router matched is
  on the context and nothing leads to it from the request. The wrapper passes arguments, results and errors through
  untouched, is put in place from the **first request** and not at start-up — it looks for the Koa your application has
  already loaded, in the module cache, and loads nothing — and an application without Koa pays for that look once.
  Next.js route templates wrap nothing: the template is read off the request, where Next leaves it.
- Sending is asynchronous with `fetch`, off the request path; a bounded queue of 6 intervals — if the cloud is unreachable, the oldest is dropped.
- Each kind of cloud failure gets its own answer: a batch the cloud calls invalid (400, 413, 422) is **discarded**, counted as `rejected` and reported once, rather than taking a queue slot from batches that are fine; a rejected **token** (401, 403) keeps the batch, because that is temporary and those intervals are worth having once it is fixed; a 429 **waits** for what `Retry-After` asks, up to a day; a 5xx or a network error is retried.
- Every hook is guarded; after 10 internal errors the instrumentation disables itself and says so once.
- At most 500 distinct routes per interval; the rest fold into `(other)`.
- At most 60 distinct dependencies per route per interval; the rest fold into one `(other)` row of their kind that keeps their calls, time and errors, so the batch never outgrows the schema's 64 and a busy route cannot sink the interval of every route.
- At most 63 operations per route in a profile, queries, calls and commands alike; the rest fold into `(other)` buckets, one per kind they merge, that say how many each merges, so a cap never hides work that happened and never counts a call as a query. What a route ran is kept by the time it took; the errors beside it are kept first.
- Query texts are normalised once per distinct text and cached, so repeating the same query costs a map lookup, not a re-parse.
- Measured overhead budget: < 1 ms added at p99, < 3 percentage points of CPU, < 64 MiB. Measured after every merge that can move it, on a machine with nothing else on it, and by hand with `make bench`; never as a gate before a merge.
- Nothing has to be taken on trust: `DOWNTRACE_INSPECT` writes the exact batch, and needs no account.

## Requirements

Node.js 20 or newer (see `engines`); the built package is exercised on Node 20, 22 and 24 in CI.

`pg`, `mysql2` and Express are resolved from your application's entry where Node runs it, so they are the ones your
application loads; and so is the `pg` that `@prisma/adapter-pg` brings, from where that adapter is. Started through a symlinked binary — `npm i -g`, a `/usr/local/bin/<app>` — that is the file
the link points to, as it is for Node, and the link itself when the process runs with `--preserve-symlinks-main`
(on the command line or in `NODE_OPTIONS`), as it is for Node too. Started with `node .` or `node <directory>`,
they resolve from inside that directory, where Node finds your `main`: from the directory, not from the `main`
itself, which differs only for a `main` that is a symlink out of it or that has a `node_modules` of its own
between it and the directory. A `pg` that cannot be resolved from there is reported as `unavailable` in the
batch's observers, which `DOWNTRACE_INSPECT` shows you. A `mysql2` that cannot be resolved is not observed, and the
batch does not say so yet: the protocol's `observers` names four switches and has no key for it, so without a
MySQL dependency on a route you cannot tell «the application does not use it» from «it could not be found».
`DOWNTRACE_DEBUG=1` says it at start-up.

Express route templates are used when present, and for a mounted router the template is the mount **as it was
registered** plus the route: `app.use("/tenants/:tenant", router)` is `/tenants/:tenant/users/:id` for every
tenant — one route, not one per tenant. That is also what keeps a tenant's name out of the template when it is
a plain word the heuristic below leaves as written. The route a request matched keeps that template when it fails
and the error is answered outside the router that held it: the mount is read from the dispatch that matched the
route, not from the `baseUrl` Express leaves behind. When a mount's pattern cannot be recovered with confidence,
its segments come out as `:param` instead of the values they carried — the requests still group under one stable
route. That happens for a mount registered with a regular expression (there is no pattern to read), for an app
mounted under a router (Express records no prefix in that case), for a mount registered before the instrumentation
started — start the agent before the routes are registered, and `--import` does that for you — and for routes
registered on a copy of Express different from the one the agent wrapped (a duplicated dependency). A middleware that
answers under a mount before any route matched — a 401 from `app.use("/tenants/:tenant", auth)` — keeps the mount's
pattern too: the mount is read from the routers the request went through, and the rest of the path goes through the
heuristic below. Where the same stretch is matched by two mounts registered with different patterns, or by routers the
walk cannot tell apart, the stretch comes out as `:param` per segment — and so does a mount registered with several paths on Express 4, which keeps no matcher per path.

**A request that no route names is `(unmatched)`.** When Express is answering and no route matched the request and
no mount is left to name it, its route is `(unmatched)`, one per method — `GET (unmatched)`, `POST (unmatched)` —
and nothing of its path travels. That is a 404; a file served by a mount with no route,
`app.use("/", express.static(dir))`; a middleware of the first level that answers, a proxy, a CORS preflight a
`cors` middleware answers, or a gate that says «starting up»; a path asked before the application registered its route; a route registered with a regular
expression, which has no words to be written back; and a middleware that hands an error on to the app's handler
(`express-jwt` rejecting, passport with `failWithError`), which leaves `baseUrl` back at nothing by the time the
handler answers, even when the middleware sat under `app.use("/tenants/:tenant", auth)`. It is named so because
the path of such a request is not a template, and in some applications it is a secret: n8n fires a workflow for
whoever knows the path of a webhook, and a word without digits is a segment no rule of shape can tell from a route's
own words. A scanner's thousand paths (`/.env`, `/wp-login.php`), and the hundreds of files a bundler writes, are
one route and not as many, and they stop competing for the 500 routes of an interval. What is lost is which URL no
route named, and the name of a mount for a middleware that hands an error on; the lasting answer to both is a route
registered with its template. To keep the requests out altogether, the endpoint exclusion matches it like any
other name: `DOWNTRACE_EXCLUDE_ENDPOINTS=(unmatched)`.

Where there is no Express to ask — a server on `node:http` alone, a framework that keeps no routes Downtrace reads —
there is no route to have named the request, and the heuristic is the reserve: a segment that carries a value is
collapsed into `:id`: anything with
an `@` (an email, a handle), a `%` (a percent-encoding), a digit of any script unless the whole segment is a
version (`v1`, `v2`, `v1.2`), a run of 16 or more with an uppercase in it, a UUID, and a run of 24 or 32+ hex.
A plain word — a name, a slug, a file name with no number — travels as written: no rule of shape can tell a
parameter from a route's own words, and the ways to keep it out are an endpoint exclusion, matched against
the template, and minimal mode. The same heuristic names the rest of the path after a mount that answered, as
above.

A route registered after the server starts listening is that case until it exists. n8n listens first, answers
«starting up» from a middleware while it migrates, then lets Express answer a 404, and registers
`/webhook/*path` seconds later: a request in that window is `POST (unmatched)`, whatever the webhook's path —
a plain word included — and from the moment the route exists it is `POST /webhook/*path`. The files of n8n's
editor, which it serves with `app.use("/", express.static(dir))`, are `GET (unmatched)` too: from a route per
file, a thousand of them, to one.

**Koa** routes are named by the path the router registered the matched route with: `/users/:id` for `@koa/router` and
`koa-router`, which leave it on the context as `ctx._matchedRoute`. **Strapi 5** runs on Koa and on that router, so a
request to `/api/articles/1` and one to `/api/articles/2` are one route, `/api/articles/:id`, with the prefix of the
router and of the routers it is nested in; nothing of either path travels. The instrumentation finds the Koa your
application loaded in the module cache, wherever it is installed — Strapi brings its own, which under pnpm is not
reachable from your application's root — from the first request on. A route that hands on to the middleware after it
(Strapi's public files and its 404s do) is named by the route, and not by the last middleware that ran. A request
a router dispatched and none of its routes matched — a path nobody registered, or one registered for another
method — is `(unmatched)`, as in Express, and so is one matched by a route registered with a regular expression,
which has no words to be written back: the router leaves the layers it matched on the context (`ctx.matched`) before
it looks for a route, and a request that has them and no template is one that no route named. A Koa application
with no router has no routes to name a request by, and the heuristic names it as it did, and so for what the
instrumentation cannot reach: a Koa that is loaded after the first request (a lazy `import()`), a Koa bundled into one
file with the rest of the application, and a router that leaves nothing of what it matched on the context.

**Next.js** routes are named by the pathname Next matched, as the file system names it: `app/api/products/[id]/route.ts`
is `/api/products/[id]` for every product, and so are `pages/api/…`, pages and the edge runtime — with Next's own
brackets, which is the path of the file that serves it. What Next matched to no route is Next's own `/_not-found`, and no
part of the path travels. Next keeps this on the request, under a symbol it does not document; it was checked on Next
13.5, 14.2, 15.5 and 16.3 with `next start` and, on 16.3, with `output: "standalone"` too, and a version that stops
writing it is named by the heuristic as before. What Next did not route — an asset under `/_next/static`, on some
versions — is the heuristic's too.

A request can carry the template of more than one framework — a Next.js custom server behind Express answers with Express's
catch-all route, a Koa application called from an Express route — and the innermost one names it: Next.js, then Koa, then
Express.

**The first version that names a request no route named `(unmatched)` changes their route identities, once**: a
request that was a path — `/webhook/:id`, `/assets/:id`, a 404's path, a path with a plain word in it — is seen as
`GET (unmatched)` or the method's own, a finding on the old route receives no data and is not declared recovered,
and an exclusion written against such a path has to be rewritten against `(unmatched)`.

**The first version that names Koa and Next.js routes by their templates changes their route identities, once**, as the
one below did for the values: a route that was a path — a Koa one with a plain word in it, a Next.js one with its
parameter as written — is seen as the template it became, a finding on the old route receives no data, and an exclusion
written against the old name has to be rewritten against the template: `/api/products/[id]` for Next, with its brackets.

**The first version that collapses these segments changes route identities,
once:** an endpoint whose route carried a value is seen as the template it became, a finding on the old route
receives no data and is not declared recovered, and an exclusion written against a collapsed segment has to
be rewritten against the template.

## Changelog

See [`CHANGELOG.md`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/CHANGELOG.md).

## Source

This package is developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). Issues are welcome there. MIT.
