# @downtrace/mcp

## 0.1.0

### Minor Changes

- 15e073f: `@downtrace/mcp`: Downtrace as tools a coding agent can discover and use, over MCP on stdio.
  
  Nineteen tools, one per capability of the product and named after the capability rather than the HTTP route.
  Reading and operating both: `product.md` says a report exporter does not satisfy this, an agent has to be
  able to operate the product. Every operation carries an idempotency key, and the three that depend on a
  report take its version.
  
  No runtime dependencies: the protocol a tools-only server needs is three methods and it is written out.
  Without a token the server comes up read-only and says so when an operation is called, rather than refusing
  to start.

### Patch Changes

- c9c4d0a: Clear the Biome warnings in these packages' tests
  
  Test files only — an unused import and two `any` replaced by the interface the test was already asserting —
  so nothing changes in what ships. The build now fails on a warning rather than printing it (ADR 0089), and
  these were the four in the way.
