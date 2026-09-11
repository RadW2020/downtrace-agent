# @downtrace/protocol

## 0.7.0

### Minor Changes

- 96499ac: The instrumentation now reports its own resources: batches dropped, rejected and failed, internal errors, what it has shed to stay inside its budget, the memory its registers hold and an estimate of its hook time per request. Without them a cloud that sees nothing cannot tell "nothing happened" from "this instrumentation has been throwing batches away".
- 118486b: The instrumentation now asks for a capture when a local signal says the process is in trouble: the p99 of the event loop delay over 250 ms for two intervals in a row. The ask travels in the batch and the order comes back in the answer, on the channel that already existed; the cloud turns it into a capture of origin `automatic`, against the same budget, cooldown and concurrency as any other.
- 652118a: Reference samples. The instrumentation keeps a few requests per endpoint — chosen by a uniform reservoir, so the criterion is neither "the fastest" nor "the last ones" — and a capture now carries them with the selection, the population they were drawn from, and whether renewal was paused while the capture was open. A capture used to arrive with the detail of what went wrong and nothing to compare it against.
- 4a62489: A batch may carry a profile with no intervals
  
  `intervals` no longer requires at least one item. The profile has a cadence of its own and hangs off the
  batch rather than off an interval (ADR 0017), and requiring one meant a profile was lost whenever a window
  closed with no traffic — at shutdown, always. A batch with neither intervals nor a profile is refused by the
  cloud, with a reason, rather than by the schema: saying it in the schema took an `anyOf` that turned
  `intervals` into `unknown[]` in the generated types.
- 4a2d5ac: A batch can report that a capture really started
  
  `captures` carries what the instrumentation has to say about the captures it was asked for — for now, that
  observation began, and when. CAP-01 keeps that apart from when the capture was accepted, and until now
  nothing could say it: the state existed and had no writer. The orders travel in the ingest response and the
  answers travel in the next batch, on the same cadence and at the same cost.
- bb48212: Protocol 0.7.0: the cloud's answer to a batch is now part of the contract, and may carry `captures` — the
  captures the cloud is waiting for in that environment. `ingest-response.schema.json` describes it, with
  `IngestResponse` and `PendingCapture` exported alongside `INGEST_RESPONSE_SCHEMA_V0`.
  
  Additive as always: an agent that ignores the response body behaves exactly as it did, and `accepted` and
  `inserted` are unchanged and still required.
  
  It also carries `capture-evidence.schema.json`: what an instrumentation sends back for a capture the cloud
  asked for, on its own path (`CAPTURE_EVIDENCE_PATH`, `captureEvidencePath()`). Requests with their operations,
  in order, with starts and ends — hashes only, never the text of a query. Exported as
  `CAPTURE_EVIDENCE_SCHEMA_V0` with `CaptureEvidence`, `CapturedRequest`, `CapturedOperation` and
  `CaptureCoverage`.
- 83ec804: Protocol 0.7.0: a batch can say which observers are running
  
  `AgentInfo` gains an optional `observers` object — `pg`, `http`, `redis`, `runtime` — each `on`, `off` or
  `unavailable`. The third state is the point: without it, a service nobody is watching looks exactly like a
  service with nothing to watch. Absent means the instrumentation did not say, which is a fourth answer again and
  not the same as watching nothing.
  
  The cloud accepts it from this version; the instrumentation starts sending it in a later release (ADR 0008).
- 82b845a: An operation may carry a `class` — `select`, `insert`, `update`, `delete`, `other` — and never together with
  a `text`.
  
  `product.md` says a query the normaliser does not understand travels «solo como hash y clase», and without
  the class an omitted text is indistinguishable from one the user chose to suppress. Its presence is the
  reason the text is absent, so no separate flag is needed; the two together are rejected, being two answers to
  one question.
- 3df94fb: A batch can carry what the process threw outside any request
  
  `exceptions` reports the signatures of uncaught exceptions and unhandled rejections, with their kind and how
  often each happened. They sit on the batch rather than in the profile because they have no route — they
  happen outside a request's life, or after it ended — and filing them under a route that is not theirs would
  be worse than not having them. The text is optional for the same reason it is everywhere else: when nothing
  recognisable survives the sanitising, only the type and the signature travel, and that is not the absence of
  an exception.
- 24699a4: `RuntimeHealth` no longer requires any of its fields, and requires at least one.
  
  `product.md` says the protocol is independent of the language, and this was the exception: it demanded all
  six, so a Go runtime — which has garbage collection, a heap and a resident set, and no event loop — could
  either invent one or send none of the three it does have. Every field is optional now, with
  `minProperties: 1`, because an empty reading is not a reading.
  
  Relaxing a constraint is additive: a sender that reports all six still validates. What changes is that one
  reporting three does too.
- c934696: A batch can declare what its sender is deliberately not sending
  
  `AgentInfo.withholding` says that this sender is in minimal mode and how many endpoints and dependencies it
  excludes — counts and never names, since the name of an excluded endpoint is exactly what the user asked not
  to send. Absent means the sender did not say, not that it withholds nothing, which is the same reading as
  `observers`. Nothing sends it yet: the cloud learns to explain it first.

### Patch Changes

- b4c7e92: Fix the line numbers these packages cite in `docs/product.md`
  
  Comments only, in both packages: the citations pointed at the wrong line, and in the most repeated case at a
  blank one. No behaviour changes.
- af90c9e: Export `Observers` and `ObserverState`
  
  They were generated from the schema and not re-exported, so the instrumentation could not name the type of
  the field it fills.
- 8489cd3: Export the `Profile`, `ProfileEndpoint` and `Operation` types
  
  The schema has defined them since 0.6.0 and the generated types existed; they were just not re-exported, so a
  consumer building a profile had to reach into the generated module. No schema change.
- a23b608: The README describes protocol 0.7.0
  
  `agent.observers` — which of `pg`, `http`, `redis` and `runtime` are `on`, `off` or `unavailable` — shipped in the
  schema and never reached the README, so a consumer reading the contract from npm could not find the field that
  tells "there is no Redis" from "nobody looked at Redis". Documentation only; the contract itself is unchanged.

## 0.6.0

### Minor Changes

- d61306f: Protocol 0.6.0: a batch may carry a `profile` — what each route normally does, sent on its own cadence — with `operations` per endpoint. An operation is a `hash` (the identity, which is what the cloud groups by) plus an optional normalised `text` (the label a person reads), so suppressing the text keeps the analysis whole. Additive and optional: agents speaking 0.1 to 0.5 stay valid.

### Patch Changes

- ef6a542: `AGGREGATES_PATH` is now generated from the schema's `x-ingest-path` annotation instead of being written next to it.

## 0.5.0

### Minor Changes

- 3f87181: `PROTOCOL_VERSION` is now generated from the schema's `protocol` enum instead of being typed next to it, and the package exports `ACCEPTED_PROTOCOL_VERSIONS_V0`, the full list of published minors of v0 that the cloud still accepts.
  
  The version used to be written by hand in three places: the enum that actually decides what the cloud accepts, this package, and the cloud's Go side. Nothing compared them. The enum is now the only place it is written, both languages generate from it, and the drift check that already guards the types covers the versions too.
  
  This release also ties the package version to the protocol version: `@downtrace/protocol@0.5.0` speaks protocol `0.5.0`, and CI refuses a release where the two disagree, so the version in your lockfile tells you which contract you have. The README stops naming a schema annotation that does not exist.

## 0.4.0

### Minor Changes

- 662e8f5: Protocol 0.5.0: optional `waitMs` on each dependency, the time requests spent waiting to be able to talk to it rather than talking to it. A saturated connection pool shows up there and nowhere else. Agents on 0.4.x and earlier stay valid.

## 0.3.0

### Minor Changes

- f88b2d3: Protocol 0.4.0: dependencies are a list, not a field per kind (ADR 0011). An endpoint carries `dependencies`, one entry per dependency with `kind` (`postgres`, `mysql`, `redis`, `http`), `target` (the host for outgoing HTTP), a calls-per-request histogram, total and slowest call, and errors. Outgoing HTTP, Redis and MySQL now need no schema change of their own.
  
  `postgres` is deprecated but still accepted and translated by the cloud, so agents on 0.2.x and 0.3.x keep working; it goes away in v1.
  
  **Renamed exports**, since the buckets are no longer Postgres-specific: `QUERIES_PER_REQUEST_BOUNDARIES_V0` → `CALLS_PER_REQUEST_BOUNDARIES_V0`, `QUERIES_PER_REQUEST_BUCKETS_V0` → `CALLS_PER_REQUEST_BUCKETS_V0`, `queriesPerRequestBucket()` → `callsPerRequestBucket()`. Adds the `Dependency` type.
- 831e376: Protocol 0.3.0: optional `runtime` per interval with event loop delay (p50, p99, max), garbage collection time and count, heap and RSS, and peak in-flight requests. It is what tells a saturated process apart from a slow dependency. Adds the `RuntimeHealth` type; agents on 0.1.x and 0.2.x stay valid.

## 0.2.1

### Patch Changes

- 7c267ba: README: document the `postgres` field, the queries-per-request bucket helpers added in 0.2.0, and how the protocol evolves (additive optional fields, minor bumps, an enum of published versions).

## 0.2.0

### Minor Changes

- 1f30299: Protocol 0.2.0: optional `postgres` field per endpoint (queries-per-request histogram, total and max query time), and the batch's `protocol` field accepts every published minor of v0 so agents on 0.1.x keep working. Adds `QUERIES_PER_REQUEST_BOUNDARIES_V0`, `QUERIES_PER_REQUEST_BUCKETS_V0` and `queriesPerRequestBucket()`.

## 0.1.0

### Minor Changes

- 1a05394: First public release. Protocol v0 (aggregates schema with fixed-bucket latency histograms) and agent v0: observes incoming HTTP requests via diagnostics_channel, aggregates per route and 10-second interval, ships batches off the request path with a bounded queue, and disables itself on internal errors.
