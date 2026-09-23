# reference-app

Reference Node backend with the shape of the ICP's backends: Express 5, PostgreSQL (`pg`), Redis (`ioredis`) and a simulated external provider that real HTTP calls go to. Its regressions are switched on and off at will, and it exposes its own truth —what each request did— so that benchmarks, tests and evals have something to compare against. It depends on `@downtrace/agent` for the two calls ERR-02 needs and for nothing else: two lines, both inert when the instrumentation is not loaded, and the section below says which and why.

## Getting it up

```sh
make dev            # Postgres 17 + Redis 8 in Docker and the app with reload on :4000 (provider on :4001)
make test-integration
```

Configuration by environment in `.env.example`; the defaults match `docker-compose.yml`. What `.env.example` does not tell you:

- `PORT=0` and `PROVIDER_PORT=0` pick a free port (which is how the bench harness starts the app); the app listens only on `127.0.0.1`.
- `STARTUP_FAILURE_MS=<ms>` simulates a cold database: product traffic gets a 503 (`ColdStartError`) for that many ms from the first request; `/__admin/*` is unaffected. 0 switches it off.
- An unknown name in `REGRESSIONS` aborts start-up. A malformed integer in any variable falls back to the default without a warning.
- Every 5xx leaves a JSON line on stderr (`level`, `status`, `method`, `path`, `error`, `message`); the bench copies it into the reason for its verdict.

## Endpoints

| Route | What it does | Normal profile |
|---|---|---|
| `GET /healthz` | `{status, version}` (`APP_VERSION`) | — |
| `GET /products` | list of products | 1 query |
| `GET /products/:id` | one product | 1 query |
| `GET /me` | user from `x-user-id` (1 by default), cached in Redis for 300 s | miss: 1 query + 2 Redis · hit: 1 Redis |
| `POST /checkout` | `{userId, items:[{productId, quantity}], coupon?}` → a paid order | **12 queries, 2 provider calls, 3 Redis** |

## Regressions

They are switched on at start-up with `REGRESSIONS=n_plus_one,slow_dependency`, or live with `PUT /__admin/regressions`:

```json
{ "slow_dependency": { "enabled": true, "params": { "delayMs": 300 } } }
```

| Name | Effect | Parameters (default) |
|---|---|---|
| `n_plus_one` | checkout makes 4 queries per line instead of 3 for the whole order | — |
| `slow_dependency` | the provider takes `delayMs` longer | `delayMs` (3000) |
| `aggressive_retries` | provider calls with a short timeout and retries without backoff | `timeoutMs` (500), `retries` (3) |
| `pool_leak` | a fraction of checkouts does not return its connection to the pool | `rate` (0.2) |
| `new_error` | a fraction of `GET /products/:id` throws `InventoryMismatchError` | `rate` (0.1) |

The provider calls happen inside the transaction on purpose: it is a common shape in production, and it is what turns a slow dependency into pressure on the pool.

## What it asks of Downtrace, and why

Two lines, and they are the two things installing without touching the code cannot do (ERR-02):

- `app.use(expressErrorHandler())`, registered before this app's own error handler, so the exception Express turns into a 5xx arrives with a type, a message and a stack signature instead of as a bare status class. It records the error and calls `next(err)`, so the response is the one this app gave before it was there.
- `captureException(err, …)` in the provider client's retry, which is a failure the application **handles**: it retries, and the request carries on. From the outside nothing went wrong, so no hook can see it.

Both do nothing at all when the instrumentation is not loaded, which is how the benchmark's baseline rounds run. Setting `failureRate` to 1 through `PUT /__admin/provider` makes the second one happen on demand.

## Beside the error tracker (ESC-16)

`product.md` says the replacement goes first beside the tracker and only then instead of it, so this app can run both instrumentations at once, the way an application in the middle of a migration does. **`@sentry/node` is a development dependency of this package and of no other**, pinned to an exact version: `@downtrace/agent` never depends on a tracker, and `packages/bench` reaches this one through the workspace when it needs it (gh-615). Verified with **@sentry/node 10.75.0**; a bump is a new verification, which is why the version is exact and is written here.

```sh
SENTRY_DSN=… node --import @downtrace/agent/register --import ./src/sentry.ts src/main.ts
```

- `src/sentry.ts` is the tracker's entry point and the only thing that calls `Sentry.init`; it reads what `src/config.ts` read from the environment, because that module is the one place that reads it. With no `SENTRY_DSN` it does nothing, so loading it is never what turns the tracker on.
- `SENTRY_DSN` is also what makes `main.ts` wire the tracker into the app: its Express error middleware beside `expressErrorHandler()`, and its `captureException` beside ours in the provider client's retry, with the same error and the same context. A DSN set with the tracker never loaded aborts start-up rather than quietly running with one instrumentation.
- `TRACKER_ERROR_HANDLER=before|after` (default `after`) puts the tracker's error middleware on either side of ours. Both record and call `next(err)`, so both see the error and neither answers; the switch exists because that is a claim, and `test/coexistence.integration.test.ts` runs it both ways. Any other value aborts start-up.
- What that test compares, and what it pins as **not** working — the tracker's `pg` spans, which do not survive our start-up `require("pg")` (gh-614) — is in the test's own header.

## Admin (`ADMIN_ENABLED=1`, the default)

- `GET`/`PUT /__admin/regressions` — state and parameters.
- `GET`/`PUT /__admin/provider` — manual `delayMs` and `failureRate` of the provider.
- `GET /__admin/process` — `cpu` (`process.cpuUsage()`), `memory` (`process.memoryUsage()`), `eventLoopUtilization`, `uptimeMs`; the overhead benchmark samples it.
- `GET /__admin/stats` — per endpoint: requests, status by class, `sqlQueries`, `providerCalls`, `providerRetries`, `redisOps`, `poolWaitMs`, `errors` by type, `totalDurationMs`.
- `POST /__admin/stats/reset`.
- `GET /__admin/db/checkpoints` — what Postgres has been doing with its checkpoints: `available: false` when the database does not count it, and otherwise the counters. The bench reads it around every round because it cannot reconfigure a database that is not its own, so it reports what it measured against (gh-194).
- `POST /__admin/db/reset` — leaves the database at its starting size. The bench calls it before every round: it compares rounds with each other, and they are only comparable if they start alike (ADR 0021). It ends with a `CHECKPOINT`, so the round also starts with Postgres's timed-checkpoint clock at zero: a nine-round campaign outlives `checkpoint_timeout`, and without this the timed checkpoint landed inside round 8 of every run (gh-584, ADR 0136). That needs a superuser or the `pg_checkpoint` role; refused, the reset fails and says so instead of answering 204 with the clock running.

Traffic to `/__admin/*` is not counted. With `ADMIN_ENABLED=0` these routes do not exist (404).
