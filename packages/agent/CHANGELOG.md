# @downtrace/agent

## 0.2.0

### Minor Changes

- 59fe767: Per-request context and Postgres composition: the agent counts the queries each request makes, their total and slowest duration, and reports the distribution per route (protocol 0.2). It wraps `pg`'s `Client.prototype.query` without any code change in your application, passing arguments, results and errors through untouched. `DOWNTRACE_INSTRUMENT=none` turns it off.

### Patch Changes

- Updated dependencies [1f30299]
  - @downtrace/protocol@0.2.0

## 0.1.2

### Patch Changes

- ef87598: README: document `DOWNTRACE_DEBUG=true`, `http://` URLs and the interval fallback.

## 0.1.1

### Patch Changes

- 7d83e3e: README: state the Node versions the built package is verified on and link the changelog.

## 0.1.0

### Minor Changes

- 1a05394: First public release. Protocol v0 (aggregates schema with fixed-bucket latency histograms) and agent v0: observes incoming HTTP requests via diagnostics_channel, aggregates per route and 10-second interval, ships batches off the request path with a bounded queue, and disables itself on internal errors.

### Patch Changes

- Updated dependencies [1a05394]
  - @downtrace/protocol@0.1.0
