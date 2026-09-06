# @downtrace/protocol

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
