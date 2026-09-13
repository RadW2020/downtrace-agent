# reference-app

Reference Node backend with the shape of the ICP's backends: Express 5, PostgreSQL (`pg`), Redis (`ioredis`) and a simulated external provider that real HTTP calls go to. Its regressions are switched on and off at will, and it exposes its own truth —what each request did— so that benchmarks, tests and evals have something to compare against. It does not include the agent, nor depend on it.

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

## Admin (`ADMIN_ENABLED=1`, the default)

- `GET`/`PUT /__admin/regressions` — state and parameters.
- `GET`/`PUT /__admin/provider` — manual `delayMs` and `failureRate` of the provider.
- `GET /__admin/process` — `cpu` (`process.cpuUsage()`), `memory` (`process.memoryUsage()`), `eventLoopUtilization`, `uptimeMs`; the overhead benchmark samples it.
- `GET /__admin/stats` — per endpoint: requests, status by class, `sqlQueries`, `providerCalls`, `providerRetries`, `redisOps`, `poolWaitMs`, `errors` by type, `totalDurationMs`.
- `POST /__admin/stats/reset`.
- `GET /__admin/db/checkpoints` — what Postgres has been doing with its checkpoints: `available: false` when the database does not count it, and otherwise the counters. The bench reads it around every round because it cannot reconfigure a database that is not its own, so it reports what it measured against (gh-194).
- `POST /__admin/db/reset` — leaves the database at its starting size. The bench calls it before every round: it compares rounds with each other, and they are only comparable if they start alike (ADR 0021).

Traffic to `/__admin/*` is not counted. With `ADMIN_ENABLED=0` these routes do not exist (404).
