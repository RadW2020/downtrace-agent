# @downtrace/mcp

## 0.2.0

### Minor Changes

- 99b47e1: The three operations that RES-01 names as depending on the state that was read — `close_finding`,
  `accept_reference`, `assess_hypothesis` — now declare and require the report's `version`, the one
  `read_report` gives. A caller that omitted it, or that passed one that is not a usable string, gets an
  error before anything is sent; the API keeps the header optional for its own callers (ADR 0074), and
  the check the cloud applies when the version is present is the same.
- a3fb34c: A retry of an operation through the MCP is not a second operation.
  
  Every operation declares an optional `idempotencyKey`, and each description says when a key may be reused:
  the retry of the same operation after a failure or a dropped connection passes the same key, which the cloud
  answers with the result of the first call; a new operation passes a different key, or none, and without a key
  the server generates one. An empty or non-string key is treated as absent rather than sent, because an empty
  header would turn the cloud's gate off.
- 1a05508: Two tools for errors: `list_errors` and `read_error`.
  
  Every error the cloud has observed, from its first observation and with no traffic minimum: its identity —type,
  sanitised message and stack signature, under `fromService` like everything else the observed service wrote—,
  how many times it happened, when it was first and last seen, and in which environments, versions and routes.
  `read_error` adds where each of those sightings happened, with its own count and its own two instants.
  
  An error is not a finding, and neither tool pretends otherwise: a finding is a detected difference and an error
  is an observed fact, so an error listed here may have no finding about it and that says nothing either way. The
  answers carry what they cannot say, including the point at which a project's budget stopped keeping new
  signatures.
  
  Both read, neither operates, so a server started with no credential answers them.
- b7ca5aa: `project_status` takes `sort` and `order`, and the endpoints come back in that order.
  
  `sort` is one of `environment`, `endpoint`, `requests`, `errors`, `p50`, `p95`, `p99` or `max`, and `order` is
  `desc` or `asc`. The worst come first unless you ask otherwise, which is what the headers of the project page
  do on the first click. The cloud orders by the measurement and not by the text it prints, so `> 60.00 s` is
  above `49.9 ms`, and a route with no requests is last on every measurement instead of passing for the
  fastest. The answer says which order it applied under `endpointsSort`, including when you asked for none. A
  value the cloud does not know is refused with the list of the ones it does.
- 75f781b: `list_errors` takes `sort` and `order`, and the errors come back in that order.
  
  `sort` is `last-seen` (the default, and the order the list always had), `first-seen`, which puts first the
  errors that arrived most recently, or `occurrences`, how many times each was seen. `order` is `desc`, the newest
  or the most first, or `asc`. The cloud applies the order before `limit`, so the first fifty by first seen are the
  fifty newest errors and not the fifty last seen in another order, and errors that tie stay in the default order.
  The answer says which order it applied under `sort`, including when you asked for none, and a value the cloud
  does not know is refused with the list of the ones it does. These are the orders the headers of the errors page
  give.
- 01322ab: `read_history` asks for the comparison the history page shows.
  
  `baselineFrom` and `baselineTo`, both or neither, are the other window the history page compares against: with
  them the answer adds `baseline`, the window as asked for with whether the series covers it, and `comparison`,
  one row per endpoint and metric with before, after, the change and whether it got worse — the same table the
  page shows, over the same two reads. One of the two alone is refused with the reason the page gives for the
  same selection, and a side with nothing in the series comes back as `comparison: []` with `limits` naming the
  side. Without them the read is the one-window read it has always been.
- ec1757f: A tool for the list of projects: `list_projects`.
  
  The front page is a capability of the interface — every project, in the order the page reads them, with how many
  findings are open, when the last batch arrived and the word of the page's column — and invariant 13 gives it
  programmatic access with the same semantics. The cloud answers it at `GET /api/projects`, with the same data and
  the same words the page says, and the tool calls it with the session's credential: the shared administration
  password opens it, and a project's key does not, which is the cloud's answer and not the tool's refusal. It is the
  way an agent that does not know a project's slug learns it.
- c0fa46e: Four tools for the triage of an error: `resolve_error`, `ignore_error`, `unignore_error` and `annotate_error`.
  
  Resolving files an error as dealt with, attributed. It accepts no reference, silences no detector and proves
  nothing about the code, and the occurrences go on being counted in every state. Ignoring takes it out of the
  default list until a moment you choose and it comes back on its own; nothing is silenced and nothing stops
  being counted. An error that is resolved and then happens again in a deployed version the project first sees
  after the resolution comes back as a **reappearance** of that same error, naming both versions — that is
  observed at ingestion, not asked for, and no tool does it.
  
  `list_errors` gains `state`: `waiting` by default — open and reappeared, the ones waiting for somebody — or
  `open`, `resolved`, `ignored`, `reappeared`, `all`. Every answer says which filter it applied and how many
  errors it is not showing. `read_error` now carries the error's state and its whole triage history.

### Patch Changes

- b289861: The schema says, for every value of `Operation.kind` and of `ProcessException.kind`, the first minor that carries it,
  as `x-since` beside each enum. It is what lets a reader tell a kind of error a sender cannot send from one it did not
  send: an instrumentation that speaks 0.6.0 can carry an operation that failed inside a request and no other kind, and
  an empty list of errors from it is not an absence of errors. The descriptions of both enums stop repeating the
  versions in prose, since the annotation says them once.
  
  It is an annotation and not a change to the contract: every batch that was valid still is, and no field moves. A
  validator in strict mode has to be told `x-since` is a keyword, as it already had to be told the other annotations.
  
  `list_errors` says that its answer carries `reporting`: which kinds of error cannot reach the list from the instances
  reporting now, by the protocol each one speaks.
- fffa7f7: `accept_reference` says what the cloud's 409 means before the call: a finding that is already closed is not
  accepted, also when it is already accepted, because a second acceptance would overwrite who accepted it, why and
  since when the same difference stays quiet. The refusal changes nothing and carries how the finding stands
  closed, with the acceptance that closed it in `accepted` — `by`, `why`, `at` and whether `declared` — so a
  coding agent whose own acceptance went unanswered reads it there, and corrects a reason with an annotation.
- 0ffdf86: `close_finding` says who `closedBy` names in the cloud's 409: who closed the finding by hand or accepted its
  reference, with whether that who is declared in `closedByDeclared`, and none on an observed recovery or on an
  acceptance whose who was not recorded. It used to say that a `closedBy` meant a close by hand, which stopped being
  true when an accepted finding began to keep who accepted it.
- 62660c1: `list_errors` says that `kind` is how the instrumentation came to see an error — an instrumented operation
  failed, the framework turned it into a 5xx, the application reported it itself, or the process threw it
  outside any request — and `read_error` says that an error the application reported carries, under
  `fromService`, the structural context it attached.
- b9052cd: The published READMEs now say what `product.md` already promised and the package pages did not: this is a
  closed free pilot, with no plans, no billing and no SLA, and an ingestion protocol at `v0` that can still
  change between minor versions. The notice sits under the title, where somebody landing on the npm page reads
  it without scrolling.
- 7e5c49d: The product definition these packages cite is now in English, and so are the citations. Nothing executable
  changed: the schemas keep every field, type and constraint they had, and the only edits inside `packages/` are
  comments and the `description` of each schema property. Those descriptions ship — the JSON schema downloaded
  from npm carried thirteen quotations in Spanish, quoting a document that is no longer written in it.

## 0.1.2

### Patch Changes

- d68f87d: Refuse a publish that would ship broken entry points. These packages develop pointing at their sources and rely on `publishConfig` to rewrite `exports` and `bin` to `dist/`; npm does not apply `publishConfig` and pnpm does, so `npm publish` from the package directory ships a manifest naming files the tarball does not carry. That is how `@downtrace/mcp@0.1.0` went out unusable. A `prepublishOnly` guard now refuses that publish and says how to do it, and the tarball check verifies that every entry point a manifest names is inside the tarball.

## 0.1.1

### Patch Changes

- 7f23137: The server reads its version from the manifest npm publishes, instead of repeating it in a constant nothing bumps. The first release of this package moved the manifest to 0.1.0, the constant stayed at 0.0.0, and the test that held the two together turned main red — which is the test doing its job and nobody being able to do theirs.

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
