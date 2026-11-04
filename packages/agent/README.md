# @downtrace/agent

> ⚠️ **Not production ready.** Downtrace is a closed free pilot: no plans, no billing and no SLA. The ingestion protocol is `v0` and can still change between minor versions. Install it where a dependency that is still moving is acceptable.

**A flight recorder for your Node.js backend.** Downtrace watches how your application normally behaves and, when something gets slower or breaks, tells you what changed. This is the **instrumentation**: it observes your application from the inside, aggregates locally per route and 10-second interval, and ships compact batches to the Downtrace cloud — never in your request path, never able to throw into your code, with bounded memory.

It observes six things, each of which can be switched off with `DOWNTRACE_INSTRUMENT`:

| Name | What it sees |
|---|---|
| `http` | Incoming requests by route, and outgoing calls by host, with status and duration |
| `pg` | Postgres queries per request, their time and errors, and how long a request waited for a connection; Prisma 7's too, [through `pg`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#prisma); [Neon's driver](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#neon)'s over its WebSocket; and [postgres.js](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#postgresjs)'s, with no wait and no server |
| `mysql` | MySQL and MariaDB queries per request through `mysql2`, `mysql` and `mariadb`, their time and errors, and how long a request waited for a connection |
| `mssql` | [SQL Server](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#sql-server) statements per request through `tedious`, and so through `mssql`, TypeORM, Knex, Sequelize and Prisma's adapter, by server, their time and errors |
| `sqlite` | [SQLite](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#sqlite) statements per request through `better-sqlite3`, `libsql` (and so `@libsql/client` on a file, and the ORMs that run on either) or `sqlite3` (Knex's and Sequelize's), their time and errors |
| `mongodb` | [MongoDB](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#mongodb) commands per request through its official driver, and so through Mongoose, by command and collection, their time and errors |
| `prisma` | [Prisma](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#prisma)'s operations per request from 3.15 to 6, through its own engine, by action and model (`findMany Post`), under the database they reach, their time and errors |
| `redis` | Redis commands per request, by server, through `ioredis` or `redis` (node-redis 5.12 and later) |
| `runtime` | Event loop delay, GC pauses, heap, RSS and requests in flight |

It watches only the process it is loaded into: one process, one service. In this documentation the **instrumentation** is this library and a **coding agent** is whoever operates Downtrace; the package keeps its older name.

## Before you deploy, with no account

Your tests pass, and a change made a route run a query once per row. `downtrace check` runs your tests on `HEAD` and on your working tree, and tells you, route by route, what each request now runs that it did not:

```sh
npm install --save-dev @downtrace/agent
npx downtrace init     # finds your test command, writes downtrace.json; asks nothing
npx downtrace check    # exit 0: no route got worse · 1: one did · 2: no comparison could be made
```

```
Worse (1)
  GET /orders   3 requests in the base, 3 in the change
    appeared   SELECT name FROM users WHERE id = ?  [query 0ee1294e0ade7fb8]  0 -> 50 per request
    appeared   SELECT id, total, user_id FROM orders ORDER BY id  [query fb36696aebd98a68]  0 -> 1 per request
    gone       SELECT o.id, o.total, u.name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id  [query 0ad9139c76ae524a]  1 -> 0 per request
    request duration, shown and not judged: 1 ms -> 14.82 ms
```

Nothing leaves the machine: the runs get no token and no URL. Durations are shown and never judged, since a test run is not production; the verdict comes from what each request ran — queries, outgoing calls, Redis commands — and how many times. A route the tests did not reach is said to be not evaluated, by name, and never unchanged. A coding agent reads the same result with `--json`.

The whole of it: [`downtrace init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md), which configures a project asking nothing and making no network request, and [`downtrace check`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md). Production, with the cloud, starts below.

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
| `DOWNTRACE_ENV` | no | Environment; falls back to `NODE_ENV`, then `production`. The token's environment is what decides where the data lands (below) |
| `DOWNTRACE_VERSION` | no | Deployed version or commit; detected from `APP_VERSION`, `GIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `HEROKU_SLUG_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`; else `unknown` |
| `DOWNTRACE_DEBUG` | no | `1` or `true` to log the instrumentation's own activity to stderr |
| `DOWNTRACE_INTERVAL_MS` | no | Aggregation interval in ms (min 1000; default 10000; anything else falls back to the default) |
| `DOWNTRACE_PROFILE_MS` | no | How long a profile window stays open, in ms (default 60000; never below `DOWNTRACE_INTERVAL_MS`, and never above two and a half minutes minus the interval — [why](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/data.md#what-each-route-normally-runs)). Shortening it multiplies the profile rows in proportion, and those count against the project's daily budget |
| `DOWNTRACE_INSTRUMENT` | no | Which observers run: `all` (default), `none`, or a list like `pg,mysql,sqlite,mongodb,prisma,http,redis,runtime` |
| `DOWNTRACE_MINIMAL` | no | `1` to send no free text at all (below) |
| `DOWNTRACE_QUERY_TEXT` | no | `off` to send query fingerprints without their normalised text. The hash is the identity, so the analysis is unchanged |
| `DOWNTRACE_EXCLUDE_ENDPOINTS` | no | Route templates not to observe at all, comma-separated; `*` stands for any run of characters and the whole template has to match (`/admin/*`). The cloud is told how many are missing, never which |
| `DOWNTRACE_EXCLUDE_DEPENDENCIES` | no | Dependency targets not to observe at all, the same way (`api.stripe.com`) |
| `DOWNTRACE_INSPECT` | no | `stderr` or a file path: writes every batch exactly as it would be sent. With it set, `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` become optional |
| `DOWNTRACE_SHED` | no | `nothing` (default), `fine` or `profile`: the least the instrumentation gives up, whatever its own meter measures. The benchmark's switch; leave it alone in production |
| `DOWNTRACE_PG_DEPTH` | no | `full` (default), `context` or `wrapper`: how much of the Postgres observer's attribution runs. The benchmark's switch; leave it alone in production |

An ingest token belongs to one environment, and **that** is the environment everything sent with it is stored as, whatever `DOWNTRACE_ENV` says. If the two disagree, the data still lands — going blind over a mislabelled deploy would be worse than the wrong label — and the project's page shows the instance as declaring something else, which is usually a variable to fix. Tokens minted before per-environment tokens existed are unbound and keep letting the batch declare.

Without `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` (or with a `DOWNTRACE_URL` that is not `http(s)://`) the instrumentation prints one warning and does nothing else: it loads none of your dependencies and changes none of them. So you can add it to a deployment before you have a token: nothing changes until both exist.

## If your build prunes dependencies it cannot see

`--import` loads the instrumentation from the command line, so **nothing in your code imports it**. Bundlers that ship only what is imported — Next.js `output: "standalone"`, and anything else that copies "only what is used" — leave it out, and the container dies at boot with `Error: Cannot find package '@downtrace/agent'`.

### Next.js

Use [`instrumentation.ts`](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation), which Next runs once before it serves anything. No change to your Dockerfile, your start command or `NODE_OPTIONS` — and `downtrace init` writes it for you when it finds `output: "standalone"`:

```ts
// instrumentation.ts, at the root of your project (or in src/)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@downtrace/agent/register");
  }
}
```

Because your code imports it, Next traces it and ships it, and each route is named by the file that serves it (`/api/products/[id]`). The condition is not optional: Next calls `register` in every runtime it builds for, and without it a project with a `middleware.ts` fails `next build` with `Reading from "node:module" is not handled by plugins`. Your `tsconfig.json` needs `"moduleResolution"` set to `bundler`, `node16` or `nodenext`; the classic `node` cannot resolve the `/register` subpath.

### Anything else that traces

Either import the instrumentation from an entry point you own, as above, or make the bundler keep it. In Next that is `outputFileTracingIncludes`; other tools have an equivalent.

## What leaves your server

Only structural metadata: method, **route template** (`/products/:id`, never the actual URL), status, counts and a fixed-bucket latency histogram per route and interval; per dependency, how many calls each request made and how long they took; what each route normally runs, as fingerprints; the health of the process; and the process identity (random id, hostname, pid) and the deploy (version, environment). No bodies, no headers, no query strings, no value from your database. The exact contract is the JSON Schema in [`@downtrace/protocol`](https://www.npmjs.com/package/@downtrace/protocol).

`DOWNTRACE_MINIMAL=1` withholds everything you wrote: route templates, dependency targets, your hostname and your deployed version travel as stable digests, and query text, the labels of calls and commands, error messages and exception signatures do not travel at all. Downtrace keeps detecting and comparing; what it loses is the ability to **name** anything, and it says so.

The details — every field, each driver, the profile, captures, reference samples and what the instrumentation itself costs — are in [What leaves your server](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/data.md), [Databases](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md) and [How routes are named](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/routes.md).

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
grep -i 'something-that-should-not-leave' downtrace-batches.jsonl
```

It works with a cloud too. Set `DOWNTRACE_INSPECT` alongside your token and URL and it writes **and** sends, so a
running deployment can be audited without turning it off, and what you read is what actually went out.

Two things worth knowing: **the file grows and nothing rotates it** — it is yours, and so is deciding what to do
with it — and it may contain the normalised text of your queries, which is the point, so give it the same care
you would give an application log.

## Errors

Without touching your code, a query, an outgoing call or a Redis command that fails is an error with its identity — type, sanitised message and stack signature — and so is an exception that kills the process, watched without handling it: your process ends exactly as it would have.

Two kinds no hook can see, because from the outside nothing went wrong, have a call each:

```js
import { captureException, expressErrorHandler } from "@downtrace/agent";

// An error you handled: a catch that retries, falls back or answers a 4xx.
try {
  await provider.authorize(order);
} catch (err) {
  captureException(err, { stage: "authorize", retryable: true });
  return fallback(order);
}

// An exception Express turned into a 5xx: after your routes, before your own error handler.
app.use(expressErrorHandler());
```

`captureException` has your error tracker's shape, never throws, and does nothing without the instrumentation loaded. Its context is flat, small and sanitised: anything that looks like a value travels as `?`. How the sanitising works, what each way of ending keeps and loses, and how to run it beside your error tracker are in [Errors](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/errors.md).

## Guarantees

- HTTP requests are observed through Node's `diagnostics_channel`, without touching your code. To see queries and route templates the instrumentation wraps a few methods of the drivers and frameworks it names ([which](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/routes.md#what-is-wrapped)): they pass arguments, results and errors through untouched, and if a wrapper itself fails your code still runs. `DOWNTRACE_INSTRUMENT=none` disables them.
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

Routes are named by their templates in Express 4 and 5, Koa (`@koa/router`, `koa-router`, and so Strapi 5), Next.js, Fastify 4 and 5, Hapi 21 and Hono 4; a request that no route names is `(unmatched)`, and nothing of its path travels. Anywhere else a heuristic collapses what looks like a value into `:id`. See [How routes are named](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/routes.md).

The drivers are the ones your application loads, resolved from its entry: see [where the drivers are found](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#where-the-drivers-are-found). A driver that is not found is reported, and `DOWNTRACE_DEBUG=1` says which at start-up.

## Documentation

The reference pages live beside this README, in `guide/` of the package:

- [What leaves your server](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/data.md) — every field, the profile, captures, reference samples, minimal mode
- [Databases](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md) — Postgres, Neon, postgres.js, MySQL, SQL Server, SQLite, MongoDB and Prisma, driver by driver
- [How routes are named](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/routes.md) — each framework, the heuristic, and what is wrapped
- [Errors](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/errors.md) — the two calls, sanitising, how a process ends, beside your error tracker
- [`downtrace init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md) and [`downtrace check`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md)

## Changelog

See [`CHANGELOG.md`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/CHANGELOG.md).

## Source

This package is developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). Issues are welcome there. MIT.
