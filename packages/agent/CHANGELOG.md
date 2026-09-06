# @downtrace/agent

## 0.3.0

### Minor Changes

- 775604a: The agent now reports its dependencies as a list (protocol 0.4), one entry per kind and target, instead of the deprecated `postgres` field. Failed calls are counted as errors against the dependency. Internally the per-request context counts calls per dependency rather than queries, so adding Redis, MySQL or outgoing HTTP is a few lines per driver rather than a new shape each time.
- bdc7af4: Outgoing HTTP: the agent now reports the calls each request makes to other services, grouped by host, with their time and failures. A 5xx from a dependency counts as a failure of that dependency. Nothing is patched: `fetch` and the `node:http` client both publish on `diagnostics_channel`, and the agent only listens.
  
  Known gap: when a `fetch` fails to connect at all, undici publishes nothing, so that call is not seen. The `node:http` client does report it.
- 0853ecd: Redis: the agent now reports the commands each request issues, per server, with their time and failures. Nothing is patched here either, ioredis publishes on a tracing channel.
  
  Every dependency now carries a target that says **which instance** of its kind it is, so a read replica and a primary, or two Redis servers, are two dependencies rather than one. Postgres calls now carry their host and port too.
- 91e0e8a: Runtime health: every interval the agent reports its own event loop delay (p50, p99, max), garbage collection time and count, heap and RSS, and the peak of concurrent in-flight requests (protocol 0.3). It is what tells a saturated process apart from a slow dependency, and it comes from Node's own instruments.

### Patch Changes

- 68d7d86: A `fetch` that fails to connect is now counted as a failed call to that host. undici publishes nothing at all in that case, which is precisely the "dependency is down" case, so the agent wraps `globalThis.fetch` for that one path only: it records nothing when the call succeeds or when the channels already saw it, so nothing is counted twice.
- Updated dependencies [f88b2d3]
- Updated dependencies [831e376]
  - @downtrace/protocol@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [7c267ba]
  - @downtrace/protocol@0.2.1

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
