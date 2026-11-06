# @downtrace/agent

> ⚠️ **Not production ready.** Downtrace is a closed free pilot: no plans, no billing and no SLA. The ingestion protocol is `v0` and can still change between minor versions. Install it where a dependency that is still moving is acceptable.

**A flight recorder for your Node.js backend.** Downtrace watches how your application normally behaves and, when something gets slower or breaks, tells you what changed. This is the **instrumentation**: it observes your application from the inside, aggregates locally per route and 10-second interval, and ships compact batches to the Downtrace cloud — never in your request path, never able to throw into your code, with bounded memory.

It observes these, each of which can be switched off with `DOWNTRACE_INSTRUMENT`:

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

No tests that reach your application over HTTP? Start it with `DOWNTRACE_INSPECT`, use it, stop it, and read what each route ran, the most queries per request first:

```sh
DOWNTRACE_INSPECT=./run.jsonl node --import @downtrace/agent/register app.js
npx downtrace report run.jsonl                # each route: requests, queries per request, what repeats, the slowest
npx downtrace compare base.jsonl run.jsonl    # check's verdict over two such files, recorded however you can
```

```
  GET /orders   2 requests  ·  21 queries per request on average, median 21 to 50
    repeated   select * from "users" where "id" = ?  [query 81ca38dfd955b40d]  20 per request
```

The whole of it: [`downtrace init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md), which configures a project asking nothing and making no network request, [`downtrace check`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md), and [`downtrace report` and `downtrace compare`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/report.md). Production, with the cloud, starts below.

## Install

```sh
npm install @downtrace/agent
npx downtrace init    # writes the instrument file and the line that loads it
```

The instrumentation starts from an instrument file your application loads before anything else, which calls `init()` with your DSN: the cloud's URL with your ingest token as its user, `https://dt_…@your-downtrace-cloud`. [`downtrace init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md) writes what the recipes below show. As written, the file reads `DOWNTRACE_DSN` from the environment and does nothing without it; where you cannot set the environment, write the DSN in its place, and the file sends from every machine that runs it.

### NestJS, compiled to CommonJS

```ts
// src/instrument.ts
import { init } from "@downtrace/agent";

init({ dsn: process.env.DOWNTRACE_DSN });
```

```ts
// src/main.ts: the first line, before anything else
import "./instrument";
import { NestFactory } from "@nestjs/core";
```

TypeScript turns that line into the entry's first `require`, so the instrumentation is in place before Nest builds Express and your database pool. It works on every Node from 20.

### Express

```js
// instrument.js, beside your entry
const { init } = require("@downtrace/agent");

init({ dsn: process.env.DOWNTRACE_DSN });
```

```js
// server.js: the first line
require("./instrument");
const express = require("express");
```

### Fastify

The same `instrument.js`, required by the entry's first line, before Fastify creates its instance:

```js
// app.js: the first line
require("./instrument");
const fastify = require("fastify")();
```

### ES modules

```js
// instrument.mjs
import { init } from "@downtrace/agent";

init({ dsn: process.env.DOWNTRACE_DSN });
```

```sh
node --import ./instrument.mjs server.js
```

An ES module's imports are all loaded before its first line runs, so `node` loads the file itself: in your start script, your Dockerfile's `CMD`, or `NODE_OPTIONS="--import ./instrument.mjs"`.

### Without touching the code

Where you can set the start command or the environment, no instrument file is needed:

```sh
DOWNTRACE_DSN=https://dt_…@your-downtrace-cloud \
  node --import @downtrace/agent/register server.js
# or, without touching the start command:
NODE_OPTIONS="--import @downtrace/agent/register" node server.js
```

### Configuration

Each setting is an option of `init()` and a variable of the environment: an option given wins, and one left out is read from its variable. What gets you started:

| Option | Variable | What it is |
|---|---|---|
| `dsn` | `DOWNTRACE_DSN` | The cloud's URL with the ingest token as its user: one string that connects. Or, apart, `token` and `url` (`DOWNTRACE_TOKEN`, `DOWNTRACE_URL`) |
| `env` | `DOWNTRACE_ENV` | Environment; falls back to `NODE_ENV`, then `production`. The token's environment is what decides where the data lands (below) |
| `version` | `DOWNTRACE_VERSION` | Deployed version or commit. Unset, it is found with no configuration: the variable your platform or CI sets, the image's digest on ECS, or a fingerprint of your code ([how](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/data.md#the-deployed-version)) |
| `inspect` | `DOWNTRACE_INSPECT` | `stderr` or a file path: writes every batch exactly as it would be sent, and needs no DSN ([below](#see-exactly-what-would-leave-your-server)) |

The rest — debug, the interval, the profile, which observers run, minimal mode, query text, exclusions, the benchmark's switches — and what a late `init()` loses are in [Configuration](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/configuration.md). A second `init()`, or one after `--import @downtrace/agent/register` started the instrumentation, changes nothing and says so.

An ingest token belongs to one environment, and **that** is the environment everything sent with it is stored as, whatever `DOWNTRACE_ENV` says. If the two disagree, the data still lands — going blind over a mislabelled deploy would be worse than the wrong label — and the project's page shows the instance as declaring something else, which is usually a variable to fix. Tokens minted before per-environment tokens existed are unbound and keep letting the batch declare.

Without a DSN, or `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` (or with one that is not `http(s)://`), the instrumentation prints one warning and does nothing else: it loads none of your dependencies and changes none of them. So you can add it to a deployment before you have a token: nothing changes until it has one.

To know it works, read stderr. When the cloud accepts the first batch, one line says where it landed, debug or not:

```
[downtrace] connected: shop-api / staging
```

A cloud that does not say where answers with `connected: the cloud accepted the first batch`. A token the cloud refuses is said once, and never echoed. With `DOWNTRACE_DEBUG=1` the start names the drivers it found, `drivers found: pg, mysql`: each is wrapped at its first use, once your application has loaded it, and its own `instrumented` line comes only then.

Before you deploy, check the token without sending any data:

```sh
npx downtrace verify    # downtrace verify: the token writes to shop-api / staging
```

It reads the token the instrumentation would, from `DOWNTRACE_DSN` or `DOWNTRACE_TOKEN` and `DOWNTRACE_URL`; `--dsn <dsn>`, or `--token <token>` with `--url <url>`, checks another. It never prints the token. Exit 0: the token writes where it says · 1: the cloud refused it · 2: nothing could be checked (no token, a cloud it cannot reach or that does not answer in ten seconds, or any other answer), and it says which.

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

Node.js 20 or newer; the built package is exercised on Node 20, 22 and 24 in CI. The package declares no Node version to its package manager, so adding it never fails the install of a workspace whose other apps run an older Node. On an older Node the instrumentation prints one warning and does nothing else, and `downtrace` says so in one line and exits with 2.

Routes are named by their templates in Express 4 and 5, Koa (`@koa/router`, `koa-router`, and so Strapi 5), Next.js, Fastify 4 and 5, Hapi 21 and Hono 4; a request that no route names is `(unmatched)`, and nothing of its path travels. Anywhere else a heuristic collapses what looks like a value into `:id`. See [How routes are named](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/routes.md).

The drivers are the ones your application loads, resolved from its entry: see [where the drivers are found](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md#where-the-drivers-are-found). A driver that is not found is reported, and `DOWNTRACE_DEBUG=1` says at start-up which were found and which were not.

## Documentation

The reference pages live beside this README, in `guide/` of the package:

- [Configuration](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/configuration.md) — every setting, as an option of `init()` and a variable, and what a late `init()` loses
- [What leaves your server](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/data.md) — every field, the profile, captures, reference samples, minimal mode
- [Databases](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/databases.md) — Postgres, Neon, postgres.js, MySQL, SQL Server, SQLite, MongoDB and Prisma, driver by driver
- [How routes are named](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/routes.md) — each framework, the heuristic, and what is wrapped
- [Errors](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/errors.md) — the two calls, sanitising, how a process ends, beside your error tracker
- [`downtrace init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md) and [`downtrace check`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md)

## Changelog

See [`CHANGELOG.md`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/CHANGELOG.md).

## Source

This package is developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). Issues are welcome there. MIT.
