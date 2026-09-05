# @downtrace/protocol

## 0.2.0

### Minor Changes

- 1f30299: Protocol 0.2.0: optional `postgres` field per endpoint (queries-per-request histogram, total and max query time), and the batch's `protocol` field accepts every published minor of v0 so agents on 0.1.x keep working. Adds `QUERIES_PER_REQUEST_BOUNDARIES_V0`, `QUERIES_PER_REQUEST_BUCKETS_V0` and `queriesPerRequestBucket()`.

## 0.1.0

### Minor Changes

- 1a05394: First public release. Protocol v0 (aggregates schema with fixed-bucket latency histograms) and agent v0: observes incoming HTTP requests via diagnostics_channel, aggregates per route and 10-second interval, ships batches off the request path with a bounded queue, and disables itself on internal errors.
