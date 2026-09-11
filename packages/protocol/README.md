# @downtrace/protocol

The ingestion contract between Downtrace agents and the Downtrace cloud, as a JSON Schema (draft 2020-12) plus the TypeScript types generated from it.

- `schema/v0/aggregates.schema.json` — the contract for what an agent sends. Everything else derives from it.
- `schema/v0/ingest-response.schema.json` — the contract for what the cloud answers, since 0.7.0.
- `schema/v0/capture-evidence.schema.json` — what an instrumentation sends back for a capture, since 0.7.0.
- `schema/v0/fixtures/{valid,invalid}/` — examples every implementation must accept and reject.
- Exports: `PROTOCOL_VERSION`, `ACCEPTED_PROTOCOL_VERSIONS_V0`, `AGGREGATES_PATH`, `AGGREGATES_SCHEMA_V0`, `LATENCY_BOUNDARIES_V0`, `LATENCY_BUCKETS_V0`, `latencyBucket()`, `CALLS_PER_REQUEST_BOUNDARIES_V0`, `CALLS_PER_REQUEST_BUCKETS_V0`, `callsPerRequestBucket()`, and the types `AggregatesBatch`, `Interval`, `Endpoint`, `LatencyHistogram`, `Dependency`, `PostgresStats`, …

## v0 in one sentence

Every 10 seconds, for every route, an agent sends how many requests there were, how many failed, how statuses split, and a **35-bucket fixed latency histogram** (0.5 ms → 60 s). Fixed buckets add up across instances, so the cloud can compute fleet-wide percentiles.

Since **0.2.0** an endpoint may also carry `postgres`: how many queries each request made, as an **8-bucket histogram** (0, 1, 2, 3–5, 6–10, 11–20, 21–50, 51+), plus the total and the slowest query time. It is optional, so an agent that does not observe queries omits it. That is what turns "this endpoint got slower" into "it went from 12 queries per request to 65".

`POST {DOWNTRACE_URL}/v0/aggregates` · `Authorization: Bearer <token>` · JSON · 202 accepted, 400 invalid, 401 bad token, 429 rate limit or daily budget. The 202 body is an `IngestResponse`.

## How the protocol changes

**The package version is the protocol version.** `@downtrace/protocol@0.5.0` speaks protocol `0.5.0`, and CI refuses to publish a release where the two disagree, so you can read the contract off the version in your lockfile. A release that changes the package without touching the contract moves the patch segment only.

Since **0.6.0** a batch may also carry `profile`: what each route normally does, on its own cadence rather than with every interval. Each operation is a `hash` — the identity, which is what groups them — plus an optional normalised `text`, so a sender who would rather not ship the text of their queries keeps the whole analysis and loses only the label. Queries and error signatures share one shape, so the next kind needs no new field.

Since **0.7.0** `agent` may also carry `observers`: which of `pg`, `http`, `redis` and `runtime` are `on`, `off` or `unavailable`. The third state is the point — a service nobody is watching must not look like a service with nothing to watch — and **absent is a fourth answer**, meaning the sender did not say, which is not the same as watching nothing.

Also since **0.7.0**, `RuntimeHealth` requires none of its fields and at least one of them. It used to demand all six, which made the one language-dependent corner of the protocol: a Go runtime has garbage collection, a heap and a resident set, and no event loop, so it could either invent one or send none of the three it does have. Relaxing a constraint is additive — a sender reporting all six still validates.

Also since **0.7.0**, a capture's evidence has a contract of its own: `schema/v0/capture-evidence.schema.json`, exported as `CAPTURE_EVIDENCE_SCHEMA_V0` with the types `CaptureEvidence`, `CapturedRequest`, `CapturedOperation` and `CaptureCoverage`, and its path as `CAPTURE_EVIDENCE_PATH` / `captureEvidencePath(id)`. It is the black box's fine detail, frozen: requests with their operations, in order, with **starts and ends** rather than durations — order and overlap are the whole reason for capturing detail. Hashes only; the text of a query never travels here. And it declares **two coverages**, never a total: what it observed from its effective start, and what it attached from detail still retained.

And since **0.7.0** that evidence may carry `reference`: a few requests per endpoint the instrumentation kept as something to compare the captured ones against, with `selection` —an enum, because a sender writing «representative» in a free string means nothing— the `population` they were drawn from, and `renewalPaused` when requests were observed that it deliberately did not consider. A sample has the same shape as a captured request. Being earlier does not make one healthy, and nothing here says it does: `product.md:100`.

And since **0.7.0** a batch may carry `triggers`: local signals asking for a capture. One entry per signal, with what was measured, the threshold it passed and how many consecutive intervals it stayed over — the threshold travels with the value because a number nobody can compare says nothing. The signal is an enum, not free text: the cloud files findings by footprint and the trigger type is part of it. Instants here are Unix milliseconds, like an interval's `start` and a capture's `startedAt`; the evidence, which writes dates, is a different payload with different readers. What the cloud does with one is its own business: a trigger asks for detail and claims nothing.

And since **0.7.0** `agent` may carry `resources`: what the instrumentation says its own cost and losses are — batches dropped, rejected and failed, internal errors, what it has shed to stay inside its budget, the bytes its registers hold and an **estimate** of the hook time per request, named as one. The counters are differences since the previous batch, like everything else here; the cloud adds them up. Absent is **«did not say»**, not zero: an older instrumentation sends none of it, and reading that as «nothing was lost» is the one answer this field exists to stop anybody inventing.

Also since **0.7.0**, **what the cloud answers is part of the contract**: `schema/v0/ingest-response.schema.json`, exported as `INGEST_RESPONSE_SCHEMA_V0` with the types `IngestResponse` and `PendingCapture`. It carries `accepted` and `inserted` as it always did, and may carry `captures` — the captures the cloud is waiting for in the environment the batch came from, each with what to watch, for how long, and until when. An agent that ignores the body behaves exactly as it did, which is what lets the cloud accept before any agent sends (ADR 0008).

Fields are only ever **added**, and always optional. Each addition bumps the minor version, and the batch's `protocol` field is an enum of every published minor, so a cloud that speaks 0.2 still accepts an agent that speaks 0.1. Removing or renaming a field, or moving a histogram's bucket bounds, would be a major version on a new path. Bucket bounds are declared in the schema itself (`x-latency-boundaries-ms`, `x-calls-per-request-boundaries`), and so are the versions themselves and the ingestion path (`x-ingest-path`), so they are part of the generated contract rather than a constant someone has to keep in sync.

## Source

Developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). MIT.
