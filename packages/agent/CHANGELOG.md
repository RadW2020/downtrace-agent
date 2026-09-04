# @downtrace/agent

## 0.1.1

### Patch Changes

- 7d83e3e: README: state the Node versions the built package is verified on and link the changelog.

## 0.1.0

### Minor Changes

- 1a05394: First public release. Protocol v0 (aggregates schema with fixed-bucket latency histograms) and agent v0: observes incoming HTTP requests via diagnostics_channel, aggregates per route and 10-second interval, ships batches off the request path with a bounded queue, and disables itself on internal errors.

### Patch Changes

- Updated dependencies [1a05394]
  - @downtrace/protocol@0.1.0
