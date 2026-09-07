# @downtrace/protocol

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
