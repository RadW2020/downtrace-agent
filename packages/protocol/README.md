# @downtrace/protocol

The ingestion contract between Downtrace agents and the Downtrace cloud, as a JSON Schema (draft 2020-12) plus the TypeScript types generated from it.

- `schema/v0/aggregates.schema.json` — the contract. Everything else derives from it.
- `schema/v0/fixtures/{valid,invalid}/` — examples every implementation must accept and reject.
- Exports: `PROTOCOL_VERSION`, `AGGREGATES_PATH`, `AGGREGATES_SCHEMA_V0`, `LATENCY_BOUNDARIES_V0`, `LATENCY_BUCKETS_V0`, `latencyBucket()`, `CALLS_PER_REQUEST_BOUNDARIES_V0`, `CALLS_PER_REQUEST_BUCKETS_V0`, `callsPerRequestBucket()`, and the types `AggregatesBatch`, `Interval`, `Endpoint`, `LatencyHistogram`, `Dependency`, `PostgresStats`, …

## v0 in one sentence

Every 10 seconds, for every route, an agent sends how many requests there were, how many failed, how statuses split, and a **35-bucket fixed latency histogram** (0.5 ms → 60 s). Fixed buckets add up across instances, so the cloud can compute fleet-wide percentiles.

Since **0.2.0** an endpoint may also carry `postgres`: how many queries each request made, as an **8-bucket histogram** (0, 1, 2, 3–5, 6–10, 11–20, 21–50, 51+), plus the total and the slowest query time. It is optional, so an agent that does not observe queries omits it. That is what turns "this endpoint got slower" into "it went from 12 queries per request to 65".

`POST {DOWNTRACE_URL}/v0/aggregates` · `Authorization: Bearer <token>` · JSON · 202 accepted, 400 invalid, 401 bad token, 429 rate limit or daily budget.

## How the protocol changes

Fields are only ever **added**, and always optional. Each addition bumps the minor version, and the batch's `protocol` field is an enum of every published minor, so a cloud that speaks 0.2 still accepts an agent that speaks 0.1. Removing or renaming a field, or moving a histogram's bucket bounds, would be a major version on a new path. Bucket bounds are declared in the schema itself (`x-latency-boundaries-ms`, `x-queries-per-request-boundaries`), so they are part of the generated contract rather than a constant someone has to keep in sync.

## Source

Developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). MIT.
