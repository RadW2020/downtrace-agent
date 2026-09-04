# @downtrace/agent

**A flight recorder for your Node.js backend.** Downtrace watches how your application normally behaves and, when something gets slower or breaks, tells you what changed. This is the agent: it observes incoming HTTP requests, aggregates them locally per route and 10-second interval, and ships compact batches to the Downtrace cloud — never in your request path, never able to throw into your code, with bounded memory.

v0 observes incoming HTTP only. Outgoing calls, database queries and the black box come next.

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
| `DOWNTRACE_URL` | yes | Base URL of the cloud (`https://…`) |
| `DOWNTRACE_ENV` | no | Environment; falls back to `NODE_ENV`, then `production` |
| `DOWNTRACE_VERSION` | no | Deployed version or commit; detected from `APP_VERSION`, `GIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `HEROKU_SLUG_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`; else `unknown` |
| `DOWNTRACE_DEBUG` | no | `1` to log the agent's own activity to stderr |
| `DOWNTRACE_INTERVAL_MS` | no | Aggregation interval (min 1000; default 10000) |

Without `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` the agent prints one warning and does nothing else.

## What leaves your server

Only structural metadata: method, **route template** (`/products/:id`, never the actual URL), status, counts and a fixed-bucket latency histogram per route and interval, plus the process identity (random id, hostname, pid) and the deploy (version, environment). No bodies, no headers, no query strings. The exact contract is the JSON Schema in [`@downtrace/protocol`](https://www.npmjs.com/package/@downtrace/protocol).

## Guarantees

- Observation through Node's `diagnostics_channel`; nothing in your application is monkey-patched.
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
