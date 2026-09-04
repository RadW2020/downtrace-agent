# @downtrace/protocol

The ingestion contract between Downtrace agents and the Downtrace cloud, as a JSON Schema (draft 2020-12) plus the TypeScript types generated from it.

- `schema/v0/aggregates.schema.json` — the contract. Everything else derives from it.
- `schema/v0/fixtures/{valid,invalid}/` — examples every implementation must accept and reject.
- Exports: `PROTOCOL_VERSION`, `AGGREGATES_PATH`, `AGGREGATES_SCHEMA_V0`, `LATENCY_BOUNDARIES_V0`, `LATENCY_BUCKETS_V0`, `latencyBucket()`, and the types `AggregatesBatch`, `Interval`, `Endpoint`, `LatencyHistogram`, …

## v0 in one sentence

Every 10 seconds, for every route, an agent sends how many requests there were, how many failed, how statuses split, and a **35-bucket fixed latency histogram** (0.5 ms → 60 s). Fixed buckets add up across instances, so the cloud can compute fleet-wide percentiles.

`POST {DOWNTRACE_URL}/v0/aggregates` · `Authorization: Bearer <token>` · JSON · 202 accepted, 400 invalid, 401 bad token.

## Source

Developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). MIT.
