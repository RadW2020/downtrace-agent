# @downtrace/agent

**A flight recorder for your Node.js backend.** Downtrace watches how your application normally behaves and, when something gets slower or breaks, tells you what changed. This is the **instrumentation**: it observes your application from the inside, aggregates locally per route and 10-second interval, and ships compact batches to the Downtrace cloud — never in your request path, never able to throw into your code, with bounded memory.

It observes four things, each of which can be switched off with `DOWNTRACE_INSTRUMENT`:

| Name | What it sees |
|---|---|
| `http` | Incoming requests by route, and outgoing calls by host, with status and duration |
| `pg` | Postgres queries per request, their time and errors, and how long a request waited for a connection |
| `redis` | Redis commands per request, by server |
| `runtime` | Event loop delay, GC pauses, heap, RSS and requests in flight |

It watches only the process it is loaded into: one process, one service.

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
| `DOWNTRACE_INSTRUMENT` | no | Which observers run: `all` (default), `none`, or a list like `pg,http,redis,runtime` |
| `DOWNTRACE_QUERY_TEXT` | no | `off` to send query fingerprints without their normalised text. The hash is the identity, so the analysis is unchanged |
| `DOWNTRACE_INSPECT` | no | `stderr` or a file path: writes every batch exactly as it would be sent. With it set, `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` become optional |

An ingest token belongs to one environment, and **that** is the environment everything sent with it is stored as,
whatever `DOWNTRACE_ENV` says. If the two disagree, the data still lands — going blind over a mislabelled deploy
would be worse than the wrong label — and the project's page shows the instance as declaring something else, which
is usually a variable to fix. Tokens minted before per-environment tokens existed are unbound and keep letting the
batch declare.

Without `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` (or with a `DOWNTRACE_URL` that is not `http(s)://`) the instrumentation prints one warning and does nothing else. So you can add it to a deployment before you have a token: nothing changes until both exist.

## If your build prunes dependencies it cannot see

`--import` loads the instrumentation from the command line, so **nothing in your code imports it**. Bundlers that decide what to ship by tracing imports — Next.js `output: "standalone"`, and anything else that copies "only what is used" — will leave it out. Your dependency is in `package.json`, it is in `node_modules` on your machine, and the container dies at boot:

```
Error: Cannot find package '@downtrace/agent'
```

### Next.js

Use [`instrumentation.ts`](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation), which Next runs once before it serves anything. Three lines, no change to your Dockerfile, no `NODE_OPTIONS`, no change to your start command:

```ts
// instrumentation.ts, at the root of your project (or in src/)
export async function register() {
  await import("@downtrace/agent/register");
}
```

Because your code imports it, Next traces it and ships it. Verified on Next 15 with `output: "standalone"`: the instrumentation starts, finds your `pg` and reports queries per route.

Your `tsconfig.json` needs `"moduleResolution"` set to `bundler`, `node16` or `nodenext` — the classic `node` setting cannot resolve the `/register` subpath. Next puts one of those in new projects; older ones may still be on `node`.

### Anything else that traces

Either import the instrumentation from an entry point you own, as above, or make the bundler keep it. In Next that is `outputFileTracingIncludes`; other tools have an equivalent.

## Exceptions that kill the process

An uncaught exception and a promise rejected with no `catch` are watched through
`uncaughtExceptionMonitor`, which Node calls before any real handler and which **does not count as handling
the exception**. Your process ends exactly as it would have: same exit code, same stack trace. There is a
test that runs two processes, one with the instrumentation and one without, and compares both.

What is reported is the type, the sanitised message and the stack signature, counted per signature.

**If the process dies, the exception is lost.** Sending is asynchronous, an uncaught exception does not go
through `beforeExit`, and there is no synchronous channel to send it on. It arrives when your application
survives what it threw — because it has its own `uncaughtException` handler, or because the rejection did
not kill it — which is the common case for the ones you can still do something about.

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

You do not need it if you let the process end on its own: closing your servers and letting the event loop
empty is what runs `beforeExit`, and the instrumentation flushes there.

## What leaves your server

Only structural metadata: method, **route template** (`/products/:id`, never the actual URL), status, counts and a fixed-bucket latency histogram per route and interval, plus the process identity (random id, hostname, pid) and the deploy (version, environment). No bodies, no headers, no query strings. The exact contract is the JSON Schema in [`@downtrace/protocol`](https://www.npmjs.com/package/@downtrace/protocol).

### The health of your process

Every interval the instrumentation also reports how late Node's event loop ran (median, p99 and worst), how much time went to
garbage collection, heap and resident memory, and the peak number of requests in flight. In Node many slowdowns are
neither the database nor the network but the process itself, and a diagnosis that does not measure it will blame
whatever it does measure. It all comes from Node's own instruments, which run whether anyone looks at them or not.

### Database work per request

When your application uses `pg`, the instrumentation also counts the calls each request makes to it, how long they took in
total, the slowest one and how many failed, and reports that distribution per route. It also times how long each
request **waited for a connection** from the pool. That wait is not the database being slow, it is your application
having nowhere to run, and it is invisible in the query's own duration. It is what turns "this endpoint
got slower" into "this endpoint went from 12 queries per request to 65". **It never reads the query text or its
values**, only counts and durations.

### Calls to other services

Outgoing HTTP is reported the same way, grouped by the host your application asked for: how many calls per request,
how long they took, the slowest one, and how many failed. A 5xx from a dependency counts as a failure of that
dependency, because for "is this service degraded?" a 500 and a timeout are the same answer.

`fetch` and the `node:http` client both publish on Node's `diagnostics_channel`, and the instrumentation listens. There is one
exception: when a `fetch` cannot connect at all, undici publishes nothing, and that is exactly the case where a
dependency is down. For that, and only that, the instrumentation wraps `globalThis.fetch`: if a call rejects and nothing was
recorded for it, it counts as a failed call. On every other path the wrapper does nothing.

### Redis

The commands each request issues are reported the same way, per server: how many per request, how long they took and
how many failed. ioredis publishes on a tracing channel, so nothing is patched.

Every dependency carries a **target** saying which instance of its kind it is, taken from the driver: the host for
outgoing HTTP, host and port for Postgres and Redis. A read replica and a primary are two dependencies, not one.
MySQL will appear the same way when it is added.

The instrumentation loads before your application (`node --import`), so it wraps the driver before you import it and you write
no code. The wrapper passes arguments, results and errors through untouched, and a failure inside it runs your query
anyway. `DOWNTRACE_INSTRUMENT=none` turns it off.

### What each route normally runs

With `pg` on, the instrumentation also builds a **profile**: not only that a route made 4 queries, but which ones.
Each query text is reduced to its shape — `SELECT id FROM products WHERE id = ?` — and hashed. The hash is the
identity the cloud groups and compares by; the text is only the label you read. That is what lets Downtrace say
*«this route went from 2 executions of this query to 53»* instead of *«this route makes more queries now»*.

The profile goes out **once a minute**, separately from the 10-second aggregates, because what a route runs
changes when your code changes, not every ten seconds.

**No value from your database ever leaves your server.** Literals, parameters, quoted bodies and comments are
replaced before anything is stored or sent, and that happens in your process, not ours. If you would still rather
not send the query text at all, `DOWNTRACE_QUERY_TEXT=off` suppresses it and changes nothing else — the hash is
the identity, so you keep the whole analysis and only lose the readable label.

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

## Guarantees

- HTTP requests are observed through Node's `diagnostics_channel`, without touching your code. To count queries per
  request the instrumentation does wrap one method, `pg`'s `Client.prototype.query`: it passes arguments, results and errors
  through untouched, and if the wrapper itself fails your query still runs. `DOWNTRACE_INSTRUMENT=none` disables it.
- Sending is asynchronous with `fetch`, off the request path; a bounded queue of 6 intervals — if the cloud is unreachable, the oldest is dropped.
- Each kind of cloud failure gets its own answer: a batch the cloud calls invalid (400, 413, 422) is **discarded**, counted as `rejected` and reported once, rather than taking a queue slot from batches that are fine; a rejected **token** (401, 403) keeps the batch, because that is temporary and those intervals are worth having once it is fixed; a 429 **waits** for what `Retry-After` asks, up to a day; a 5xx or a network error is retried.
- Every hook is guarded; after 10 internal errors the instrumentation disables itself and says so once.
- At most 500 distinct routes per interval; the rest fold into `(other)`.
- At most 63 query fingerprints per route in a profile; the rest fold into an `(other)` bucket that says how many it merges, so a cap never hides work that happened.
- Query texts are normalised once per distinct text and cached, so repeating the same query costs a map lookup, not a re-parse.
- Measured overhead budget: < 1 ms added at p99, < 3 percentage points of CPU, < 64 MiB. Checked with `make bench` on a quiet machine, not on every change.
- Nothing has to be taken on trust: `DOWNTRACE_INSPECT` writes the exact batch, and needs no account.

## Requirements

Node.js 20 or newer (see `engines`); the built package is exercised on Node 20, 22 and 24 in CI. Express route templates are used when present; without a framework, identifier-looking path segments (numbers, UUIDs, long hex) are collapsed into `:id`.

## Changelog

See [`CHANGELOG.md`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/CHANGELOG.md).

## Source

This package is developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). Issues are welcome there. MIT.
