# @downtrace/mcp

## 0.4.0

### Minor Changes

- 2d1a799: `project_brief` is where a session starts, and the first tool the server lists: the project's state in one answer of at most 16 KiB, whatever its size — a headline of counts, whether telemetry arrived, what needs attention, the busiest routes, the routes whose requests run one operation more than once each, and what cannot be said —, every list with its `total` and how many it `leftOut`, and every item with its `next`: the tool of this server and the arguments that read its detail. It takes the project's slug and an optional `since`, the last 24 hours without it. `changes_since` is for what changed since you last looked, from the brief's `until`, and `read_report` comes before any decision on a finding.
- 1bf48a7: With no `DOWNTRACE_TOKEN`, the server sends, on each call, the access credential `downtrace login` stored for its `DOWNTRACE_URL` and the call's `project`, from `credentials.json` under `$XDG_CONFIG_HOME/downtrace` (`~/.config/downtrace` without it), so its configuration carries no secret. The file is read on each call that needs it, so a login made during a session is used without a restart. An expired entry is not sent, and the call says to run login again, with the command; a file other users can read or write, of another user, or a symbolic link is not used, and the call says why. `read_credential` takes an optional `project`, to pick among several stored for the cloud; with none it sends the only one. With `DOWNTRACE_TOKEN` set, nothing changes.
- 43f824a: `project_status` reads twenty endpoints with their operations by hash unless told otherwise, and takes `route`, `method`, `limit`, `offset` and `operations` to read one route, another page, or the operations with their text or counted. A tool whose argument is not given sends the `default` its schema publishes.
- 7dbd3d4: `downtrace-mcp --http` serves the same tools over MCP's Streamable HTTP transport, at `/mcp/<project>`, for an agent environment that adds a remote server by its URL. Each request carries its own access credential as a Bearer token, which its calls send in place of `DOWNTRACE_TOKEN`; without one the answer is 401 naming the server's Protected Resource Metadata, whose authorization server is `DOWNTRACE_URL`. The URL names the project: a call that names another is refused. It listens on `DOWNTRACE_MCP_HOST` and `DOWNTRACE_MCP_PORT` (`127.0.0.1:8787`), names `DOWNTRACE_MCP_PUBLIC_URL` as its origin off the loopback, and refuses an `Origin` that is neither that nor one of `DOWNTRACE_MCP_ORIGINS`. The stdio server answers as before; an argument other than `--http` is now refused instead of ignored.

### Patch Changes

- The captures an hour, and those that may run at once, are each environment's now, as the rows a day, the evidence a day and the error signatures already were: a load test on staging no longer spends production's captures. The README's section on the ingestion token, and `downtrace init` in its text and in `--json`, say that a spent budget stops its environment alone, production untouched, until it refills; the MCP server's `list_captures` and `request_capture` say that a capture refused with 429 is refused for its environment.
- 0db4d10: The README, the npm description and the MCP Registry's listing open with the same sentence, what Downtrace does: it tells you when a change breaks the performance of your Node.js backend. The README goes on with what it finds before and after a deploy, and that this package is its MCP server: what Downtrace found in production, and why, as tools a coding agent can discover and use. The keywords name the question (performance, regression, N+1, deploy). The banner that called Downtrace a closed pilot is gone; its limits are still said: free, with no plans, no billing and no SLA.

## 0.3.2

### Patch Changes

- d9378ae: The deployed version is found on any deploy platform, with no configuration. After `DOWNTRACE_VERSION`, the instrumentation reads the variable a platform or a CI sets — the list grew from eight to thirty-four, `CODEBUILD_RESOLVED_SOURCE_VERSION`, `GITHUB_SHA`, `CI_COMMIT_SHA`, Coolify's `SOURCE_COMMIT` and Fly.io's image among them — then, on ECS, the digest of the container's image from the task metadata endpoint (`image:sha256:…`), and anywhere else a fingerprint of the code (`code:…`): a hash of its content, the same across restarts and instances of one build, and new with every build that changes it. A process says one version for its whole life: the first batch waits for the search, ten seconds at most, and nothing in it delays the application's start. With `DOWNTRACE_DEBUG`, one line says which source chose the version. The MCP server tells a coding agent that a version behind `image:` or `code:` is not a commit.
- d58325c: The ingestion token, and the DSN that carries it, are public by design, like a Sentry DSN, and safe to commit, and the README says so in a section of its own: whoever holds it can send data to its project as its environment, spend its environment's rows a day, evidence a day and error signatures and the project's captures an hour, and read where it writes and which captures the cloud asks of that environment; it cannot read findings, reports, errors, evidence or pages, operate on anything, or write to another project or environment; and a new token for the environment stops the old one at once. `downtrace init` says the same in its text, and in `--json` as `token`. An access credential, `dtr_…`, is a secret, and the README of `@downtrace/mcp`, which reads one from a variable of the same name, says so.

## 0.3.1

### Patch Changes

- 4a57e80: The package names itself to the MCP Registry (`mcpName`: `io.github.RadW2020/downtrace`), so the release can list the server there by its `server.json`, version by version.

## 0.3.0

### Minor Changes

- 9619fa1: `read_history` takes an `environment`, as the history page and the API do.
  
  With it, both windows are read for that one environment; without it, every environment is read together, as
  before, and they share each window's 200-route cut. `read_capture`'s description also names
  `coverage.dependenciesTruncated`.

### Patch Changes

- 5be3c50: The `initialize` greeting says that what another consumer wrote — an annotation's note, why a finding or an error was closed, a reading of a hypothesis, a rating's note — is data too, not addressed to the coding agent and not an instruction (invariant 12).
- ed789c5: `close_finding` and `read_credential` say on whose behalf an action was made: `onBehalfOf`, the person the credential was created for, null when it was not recorded.

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
