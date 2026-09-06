# @downtrace/agent

**A flight recorder for your Node.js backend.** Downtrace watches how your application normally behaves and, when something gets slower or breaks, tells you what changed. This is the agent: it observes your application from the inside, aggregates locally per route and 10-second interval, and ships compact batches to the Downtrace cloud — never in your request path, never able to throw into your code, with bounded memory.

It observes four things, each of which can be switched off with `DOWNTRACE_INSTRUMENT`:

| Name | What it sees |
|---|---|
| `http` | Incoming requests by route, and outgoing calls by host, with status and duration |
| `pg` | Postgres queries per request, their time and errors, and how long a request waited for a connection |
| `redis` | Redis commands per request, by server |
| `runtime` | Event loop delay, GC pauses, heap, RSS and requests in flight |

It watches only the process it is loaded into. One agent, one process, one service.

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
| `DOWNTRACE_TOKEN` | yes | The project's ingest token |
| `DOWNTRACE_URL` | yes | Base URL of the cloud, `http://` or `https://`; trailing slashes are ignored |
| `DOWNTRACE_ENV` | no | Environment; falls back to `NODE_ENV`, then `production` |
| `DOWNTRACE_VERSION` | no | Deployed version or commit; detected from `APP_VERSION`, `GIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `HEROKU_SLUG_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`; else `unknown` |
| `DOWNTRACE_DEBUG` | no | `1` or `true` to log the agent's own activity to stderr |
| `DOWNTRACE_INTERVAL_MS` | no | Aggregation interval in ms (min 1000; default 10000; anything else falls back to the default) |
| `DOWNTRACE_INSTRUMENT` | no | Which observers run: `all` (default), `none`, or a list like `pg,http,redis,runtime` |

Without `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` (or with a `DOWNTRACE_URL` that is not `http(s)://`) the agent prints one warning and does nothing else. So you can add it to a deployment before you have a token: nothing changes until both exist.

## If your build prunes dependencies it cannot see

`--import` loads the agent from the command line, so **nothing in your code imports it**. Bundlers that decide what to ship by tracing imports — Next.js `output: "standalone"`, and anything else that copies "only what is used" — will leave it out. Your dependency is in `package.json`, it is in `node_modules` on your machine, and the container dies at boot:

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

Because your code imports it, Next traces it and ships it. Verified on Next 15 with `output: "standalone"`: the agent starts, finds your `pg` and reports queries per route.

Your `tsconfig.json` needs `"moduleResolution"` set to `bundler`, `node16` or `nodenext` — the classic `node` setting cannot resolve the `/register` subpath. Next puts one of those in new projects; older ones may still be on `node`.

### Anything else that traces

Either import the agent from an entry point you own, as above, or make the bundler keep it. In Next that is `outputFileTracingIncludes`; other tools have an equivalent.

## What leaves your server

Only structural metadata: method, **route template** (`/products/:id`, never the actual URL), status, counts and a fixed-bucket latency histogram per route and interval, plus the process identity (random id, hostname, pid) and the deploy (version, environment). No bodies, no headers, no query strings. The exact contract is the JSON Schema in [`@downtrace/protocol`](https://www.npmjs.com/package/@downtrace/protocol).

### The health of your process

Every interval the agent also reports how late Node's event loop ran (median, p99 and worst), how much time went to
garbage collection, heap and resident memory, and the peak number of requests in flight. In Node many slowdowns are
neither the database nor the network but the process itself, and a diagnosis that does not measure it will blame
whatever it does measure. It all comes from Node's own instruments, which run whether anyone looks at them or not.

### Database work per request

When your application uses `pg`, the agent also counts the calls each request makes to it, how long they took in
total, the slowest one and how many failed, and reports that distribution per route. It also times how long each
request **waited for a connection** from the pool. That wait is not the database being slow, it is your application
having nowhere to run, and it is invisible in the query's own duration. It is what turns "this endpoint
got slower" into "this endpoint went from 12 queries per request to 65". **It never reads the query text or its
values**, only counts and durations.

### Calls to other services

Outgoing HTTP is reported the same way, grouped by the host your application asked for: how many calls per request,
how long they took, the slowest one, and how many failed. A 5xx from a dependency counts as a failure of that
dependency, because for "is this service degraded?" a 500 and a timeout are the same answer.

`fetch` and the `node:http` client both publish on Node's `diagnostics_channel`, and the agent listens. There is one
exception: when a `fetch` cannot connect at all, undici publishes nothing, and that is exactly the case where a
dependency is down. For that, and only that, the agent wraps `globalThis.fetch`: if a call rejects and nothing was
recorded for it, it counts as a failed call. On every other path the wrapper does nothing.

### Redis

The commands each request issues are reported the same way, per server: how many per request, how long they took and
how many failed. ioredis publishes on a tracing channel, so nothing is patched.

Every dependency carries a **target** saying which instance of its kind it is, taken from the driver: the host for
outgoing HTTP, host and port for Postgres and Redis. A read replica and a primary are two dependencies, not one.
MySQL will appear the same way when it is added.

The agent loads before your application (`node --import`), so it wraps the driver before you import it and you write
no code. The wrapper passes arguments, results and errors through untouched, and a failure inside it runs your query
anyway. `DOWNTRACE_INSTRUMENT=none` turns it off.

## Guarantees

- HTTP requests are observed through Node's `diagnostics_channel`, without touching your code. To count queries per
  request the agent does wrap one method, `pg`'s `Client.prototype.query`: it passes arguments, results and errors
  through untouched, and if the wrapper itself fails your query still runs. `DOWNTRACE_INSTRUMENT=none` disables it.
- Sending is asynchronous with `fetch`, off the request path; a bounded queue of 6 intervals — if the cloud is unreachable, the oldest is dropped.
- Every hook is guarded; after 10 internal errors the agent disables itself and says so once.
- At most 500 distinct routes per interval; the rest fold into `(other)`.
- Measured overhead budget, enforced in CI: < 1 ms added at p99, < 3 percentage points of CPU, < 64 MiB.

## Requirements

Node.js 20 or newer (see `engines`); the built package is exercised on Node 20, 22 and 24 in CI. Express route templates are used when present; without a framework, identifier-looking path segments (numbers, UUIDs, long hex) are collapsed into `:id`.

## Changelog

See [`CHANGELOG.md`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/CHANGELOG.md).

## Source

This package is developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). Issues are welcome there. MIT.
