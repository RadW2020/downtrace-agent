# In production, with the Downtrace cloud (experimental)

Part of the documentation of [`@downtrace/agent`](../README.md).

[`downtrace check`](check.md) needs no account and is what this package is for today. This page is the other half: the same instrumentation loaded in production, shipping what it aggregates to the Downtrace cloud, which tells you which route got slower or started failing after a deploy, and what changed.

**Its limits.** It is experimental. Downtrace is free: no plans, no billing and no SLA. The ingestion protocol is `v0` and can still change between minor versions.

## What it observes

It observes these, each of which can be switched off with `DOWNTRACE_INSTRUMENT`:

| Name | What it sees |
|---|---|
| `http` | Incoming requests by route, and outgoing calls by host, with status and duration |
| `pg` | Postgres queries per request, their time and errors, and how long a request waited for a connection; Prisma 7's too, through `pg`; Neon's driver's over its WebSocket; and postgres.js's, with no wait and no server |
| `mysql` | MySQL and MariaDB queries per request through `mysql2`, `mysql` and `mariadb`, their time and errors, and how long a request waited for a connection |
| `mssql` | SQL Server statements per request through `tedious`, and so through `mssql`, TypeORM, Knex, Sequelize and Prisma's adapter, by server, their time and errors |
| `sqlite` | SQLite statements per request through `better-sqlite3`, `libsql` (and so `@libsql/client` on a file, and the ORMs that run on either) or `sqlite3` (Knex's and Sequelize's), their time and errors |
| `mongodb` | MongoDB commands per request through its official driver, and so through Mongoose, by command and collection, their time and errors |
| `prisma` | Prisma's operations per request from 3.15 to 6, through its own engine, by action and model (`findMany Post`), under the database they reach, their time and errors |
| `redis` | Redis commands per request, by server, through `ioredis` or `redis` (node-redis 5.12 and later) |
| `runtime` | Event loop delay, GC pauses, heap, RSS and requests in flight |

It watches only the process it is loaded into: one process, one service.

## Install

```sh
npm install @downtrace/agent
npx downtrace init                      # writes the instrument file and the line that loads it
npx downtrace login --project shop-api  # asks Downtrace's cloud for the project; you approve it in the browser
```

The instrumentation starts from an instrument file your application loads before anything else, which calls `init()` with your DSN. `downtrace init` writes what the recipes below show, and `downtrace login` prints the ingest token and the cloud's URL the DSN is made of ([`init`'s guide](init.md)). As written, the file reads `DOWNTRACE_DSN` from the environment; where you cannot set the environment, write the DSN in its place, and the file sends from every machine that runs it.

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

TypeScript turns that line into the entry's first `require`, so the instrumentation is in place before Nest builds Express and your database pool. It works on every supported Node.

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
| `version` | `DOWNTRACE_VERSION` | Deployed version or commit. Unset, it is found: a platform or CI variable, the commit `downtrace stamp` wrote, the image digest on ECS, or a fingerprint of your code |
| `inspect` | `DOWNTRACE_INSPECT` | `stderr` or a file path: writes every batch exactly as it would be sent, and needs no DSN ([below](#see-exactly-what-would-leave-your-server)) |

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

## The ingestion token is safe to commit

The token in `DOWNTRACE_TOKEN` is public by design, like a Sentry DSN, and so is the DSN that carries it, in `DOWNTRACE_DSN` or in `init({ dsn })`: put either wherever your deployment can read it, your repository, your Dockerfile or your instrument file included. It belongs to one project and one environment, it only sends, and every other door of the cloud answers it as it answers no credential at all. Whoever holds it:

- **can** send data to its project, stored as its environment — batches, and evidence for the captures the cloud asks for — and so make Downtrace report what never happened;
- **can** spend its environment's budgets — rows a day, captures an hour, evidence a day, error signatures — and a spent one stops that environment alone, production untouched, until it refills;
- **can** read, in the answers to what it sends, the project and environment it writes to, and the routes and dependencies the cloud asks that environment to capture;
- **cannot** read findings, reports, errors, evidence or pages, operate on anything, or write to another project or as another environment.

If it ends up somewhere you would rather it had not, ask whoever runs your Downtrace cloud for a new token for that environment: the old one stops working at once, and what was sent with it stays. An *unbound* token (above) writes as whatever environment the batch declares, production included: replace it with one bound to its environment before you commit it.

Only the ingestion token, `dt_…`, is public. An access credential, `dtr_…` — what a coding agent reads and operates with, and what `@downtrace/mcp` reads from a variable of the same name — is a secret: never commit it.

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

`captureException` has your error tracker's shape, never throws, and does nothing without the instrumentation loaded. Its context is flat, small and sanitised: anything that looks like a value travels as `?`.

## Guarantees

- HTTP requests are observed through Node's `diagnostics_channel`, without touching your code. To see queries and route templates the instrumentation wraps a few methods of the drivers and frameworks it names: they pass arguments, results and errors through untouched, and if a wrapper itself fails your code still runs. `DOWNTRACE_INSTRUMENT=none` disables them.
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

Node.js 18.19.0 or newer, other than Node 19, an odd release past its end of life; the built package is exercised on Node 18.19.0, 20.5.1, 20, 22 and 24 in CI. The package declares no Node version to its package manager, so adding it never fails the install of a workspace whose other apps run an older Node. On an older Node, and on 19, the instrumentation prints one warning and does nothing else, and `downtrace` says so in one line and exits with 2.

Routes are named by their templates in Express 4 and 5, Koa (`@koa/router`, `koa-router`, and so Strapi 5), Next.js, Fastify 4 and 5, Hapi 21 and Hono 4, on Node 18 in the versions that run there; a request that no route names is `(unmatched)`, and nothing of its path travels. Anywhere else a heuristic collapses what looks like a value into `:id`.

The drivers are the ones your application loads, resolved from its entry. A driver that is not found is reported, and `DOWNTRACE_DEBUG=1` says at start-up which were found and which were not.
