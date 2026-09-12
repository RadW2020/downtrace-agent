# @downtrace/agent

## 0.8.1

### Patch Changes

- db6ccf3: The prearmed detail reaches the capture. Arming worked and nothing else did: the reserve was written with no
  operations, no dependencies and no pool wait, and the one production call that assembles a capture never read
  it. A route armed by pool wait kept rows that said nothing and that nobody looked at.

## 0.8.0

### Minor Changes

- bef32b8: A route whose requests keep queueing for a database connection now arms itself: its fine detail stops being evictable by every other route's traffic for the next couple of minutes. Fifty milliseconds of pool wait per request, sustained across two intervals, over at least twenty requests.
  
  It asks the cloud for nothing — arming is silent and costs a few kilobytes — and it is read from the interval the agent already builds, so it costs nothing per request. Pool wait is the one saturation signal measured per request, so it is the one that can name the route that is suffering rather than the busiest one.
- 2dbcdcd: A route can now be armed so that its fine detail survives other routes' traffic. The fine register is one ring shared by every route, so under load the detail of the route you care about disappears under everything else; an armed route gets slots of its own that nothing else can take.
  
  Nothing arms a route yet — the local signal that does is still to come — so in practice this holds nothing and costs a lookup per request. Preallocated and bounded, it respects the instrumentation's own budget: when the agent is already shedding fine detail, the reserve stops writing too.

## 0.7.0

### Minor Changes

- 2257464: The instrumentation now sends `poolWaitMs` with every captured request: how long it waited for a connection from a pool before it could talk to the dependency at all. It already measured this per request and threw it away when the request ended, so a pool-saturation finding could say something was wrong and never how many requests it reached.
  
  Absent means the request asked no pool, which is not a wait of zero: zero is a request that asked and was served at once. Needs `@downtrace/protocol` 0.8.0, which the cloud has been reading since it shipped.

## 0.6.2

### Patch Changes

- d592205: Fixes a comment in `src/coarse.ts` saying the coarse record exists to be frozen by a capture "which does not exist yet". Captures exist: the instrumentation receives the order, observes, and sends the evidence back. This is a public file, and that sentence was the first thing anyone opening the module read.
- 2e960e3: The README's "What leaves your server" now lists what a capture sends, the reference samples that travel with it, and the instrumentation's own measured resources. The list was true and no longer complete, and an incomplete enumeration in the section somebody reads to answer exactly that question reads as a promise.
- Updated dependencies [74261e9]
  - @downtrace/protocol@0.8.0

## 0.6.1

### Patch Changes

- d68f87d: Refuse a publish that would ship broken entry points. These packages develop pointing at their sources and rely on `publishConfig` to rewrite `exports` and `bin` to `dist/`; npm does not apply `publishConfig` and pnpm does, so `npm publish` from the package directory ships a manifest naming files the tarball does not carry. That is how `@downtrace/mcp@0.1.0` went out unusable. A `prepublishOnly` guard now refuses that publish and says how to do it, and the tarball check verifies that every entry point a manifest names is inside the tarball.
- Updated dependencies [d68f87d]
  - @downtrace/protocol@0.7.1

## 0.6.0

### Minor Changes

- ca2f2d8: Keep the coarse half of the black box in memory: the last five minutes, second by second and per route, with
  requests, errors, latency and calls, plus the process's event loop delay in its own series.
  
  Until now the finest thing the agent kept was the aggregation interval, so a degradation that started and was
  detected inside the same minute had no timeline. This is what makes it possible to see **how** something began.
  
  It never leaves the process — nothing is sent, and the protocol is unchanged. Memory is bounded by construction:
  one preallocated row per route up to 128, and the whole register stays under two mebibytes, which a test asserts
  rather than a comment claiming it.
- ac19643: Errors get an identity, not just a tally.
  
  `product.md` asks the instrumentation to observe «errores y excepciones: tipo, mensaje saneado, firma del
  stack», and it only ever counted them. A Postgres query that fails now records an `error` operation beside
  its `query` one, with the type, the sanitised message and the top frames of the stack — file and line kept,
  directory dropped.
  
  The message is sanitised harder than a query's, deliberately: it is the likeliest place in the product for a
  customer's identifier to appear, and a false positive costs a `?` where a word would have read better while
  a false negative cannot be taken back.
- 7ede24b: Exclude whole endpoints and dependencies
  
  `DOWNTRACE_EXCLUDE_ENDPOINTS` and `DOWNTRACE_EXCLUDE_DEPENDENCIES` take comma-separated patterns where `*`
  stands for any run of characters. What they match is not observed at all — not an aggregate, not the black
  box, not the profile, not even the count of requests — and the batch declares **how many** distinct
  endpoints and dependencies were withheld, never which. Endpoints are matched against the normalised route
  template, so excluding `/users/:id` works and excluding `/users/123` does not pretend to.
- 0cfffb7: Keep the fine half of the black box in memory: the last tens of seconds, request by request and operation by
  operation, with the **order** and the **overlaps** that the aggregates throw away.
  
  An aggregate says a route ran fifty-six queries. Only a sequence with starts and ends says whether they ran one
  after another or all at once, and that is the difference between time added to the request and time it spent
  waiting on something it had already asked for.
  
  Two preallocated rings with absolute cursors, so nothing is allocated per request or per operation and the memory
  cannot grow. A request that runs far more operations than the cap is truncated **and says so**, and its writes are
  capped too — a runaway request must not cost its neighbours their detail. When the ring has lapped a request's
  operations, they come back marked as lost rather than as an empty list, which would read as "it ran nothing".
  
  Only the fingerprint travels here, never the text of a query. Nothing leaves the process.
- e31d810: Add `DOWNTRACE_INSPECT`: see exactly what would leave your server, without sending it
  
  Point it at `stderr` or a file path and every batch is written as the exact bytes that would be shipped, one JSON
  line each. With it set, `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` become optional, so an application can be run
  instrumented and inspected before signing up for anything. Set alongside a token and URL it writes and sends, so
  a running deployment can be audited without turning it off.
- 96499ac: The instrumentation now reports its own resources: batches dropped, rejected and failed, internal errors, what it has shed to stay inside its budget, the memory its registers hold and an estimate of its hook time per request. Without them a cloud that sees nothing cannot tell "nothing happened" from "this instrumentation has been throwing batches away".
- 118486b: The instrumentation now asks for a capture when a local signal says the process is in trouble: the p99 of the event loop delay over 250 ms for two intervals in a row. The ask travels in the batch and the order comes back in the answer, on the channel that already existed; the cloud turns it into a capture of origin `automatic`, against the same budget, cooldown and concurrency as any other.
- 8e9d634: `DOWNTRACE_MINIMAL=1`: send no free text at all
  
  Route templates, dependency targets, your hostname and your deployed version travel as stable digests of
  themselves, and query text, error messages and exception signatures do not travel at all. What stays is
  what is not yours — the protocol version, the HTTP method, the kind of each dependency, the counts and the
  timings — so detection and comparison keep working and what is lost is the ability to name things, which
  every report now says instead of showing a bare hash.
  
  What counts as free text was decided by listing every string a real batch carries, not from memory: the
  hostname and the deployed version were in it and had not been thought of. The environment is deliberately
  not withheld, because the ingest token already tells the cloud which one it is.
  
  Also fixed: a process that observed something and left inside the same millisecond produced a profile
  window of zero, which the schema refuses — losing the whole batch and opening a coverage-loss episode over
  a rounding error.
- 9ac9c79: Obey a capture the cloud asks for
  
  The orders have been travelling in the answer to every batch since the control channel landed, and nothing
  read them: `flush` looked at `res.ok` and threw the body away. Now the instrumentation picks the order up,
  starts watching, reports the effective start in the next batch — which CAP-01 keeps apart from when the
  capture was accepted — and sends what the black box holds when the window closes, on the evidence path.
  
  A capture that saw nothing sends empty evidence rather than silence, because a capture with no requests does
  not prove recovery. Every instance obeys and the first to deliver wins: the cloud answers the rest with a
  409, which is not a failure but another process having been quicker.
- 5d86818: Send a class instead of a label for a query the normaliser does not understand
  
  `product.md` says what to do in doubt — omit rather than risk it — and this is that rule for queries. A scan
  that ran off the end of a delimiter it never closed, or met a character it has no rule for, produces no
  normalised text: the operation travels as its hash and one of `select`, `insert`, `update`, `delete` or
  `other`, which the cloud shows as the fourth reason a label can be missing. The hash is still a digest of the
  normalised text, so a query that cannot be labelled is still one operation to group and compare, and
  `DOWNTRACE_QUERY_TEXT=off` keeps meaning what it meant: with the text off, neither text nor class is sent.
- 652118a: Reference samples. The instrumentation keeps a few requests per endpoint — chosen by a uniform reservoir, so the criterion is neither "the fastest" nor "the last ones" — and a capture now carries them with the selection, the population they were drawn from, and whether renewal was paused while the capture was open. A capture used to arrive with the detail of what went wrong and nothing to compare it against.
- af90c9e: Say what is being watched, and what is not
  
  Every batch now carries `agent.observers`: one state per `DOWNTRACE_INSTRUMENT` switch, computed when the
  observers actually attach rather than from what was asked for. `off` is «not asked for», `unavailable` is
  «asked for and could not attach» — a `pg` that is not resolvable from the application's root, which until now
  disappeared into a debug log while the cloud published «this service calls no database». Without this a
  service that does not use Redis and one that uses it unwatched look identical (COB-01, invariant 14).
- ddaedc1: The instrumentation measures what it costs while it runs, and gives ground when it costs too much.
  
  `product.md:241` promised «si detecta que ella misma añade latencia, se autolimita» and nothing measured the
  time spent in the hooks. Now one hook in sixty-four is timed — the others cost an increment and a comparison,
  because measuring the cost cannot be the cost — and when the estimate crosses half of what invariant 3 allows,
  the fine detail goes first, then the profile, and never the aggregate. `AgentStats` gains `shed`,
  `shedReason` and `overheadPerRequestMs`.
- 8489cd3: Send the operation profile: what each route normally runs, not only how it performed
  
  With `pg` instrumented the agent now builds and ships the `profile` section the protocol has accepted since
  0.6.0. Each query's text becomes a normalised label and a stable hash, computed once per distinct query text, and
  the profile rotates once a minute rather than with every interval. `DOWNTRACE_QUERY_TEXT=off` suppresses the
  normalised text and nothing else: the hash is the identity, so the analysis stays whole.
- a965397: `shutdown()`, for an application that calls `process.exit()`
  
  `process.exit()` does not wait for a promise in flight and does not fire `beforeExit`, so an application
  that calls it cuts off whatever the instrumentation was about to send — the interval in hand, the profile of
  the window, the evidence of a capture. `await shutdown()` before exiting hands all of it over. It is safe
  with the instrumentation switched off, safe twice, and never throws.
  
  You do not need it if you let the process end on its own; the README says which case you are in.
- b876605: Tell an invalid batch apart from an unreachable cloud, and obey `Retry-After`
  
  A batch the cloud refuses as invalid (400, 413, 422) is now discarded and counted as `rejected` — reported once —
  instead of being retried until the bounded queue evicts it, where it took a slot from batches that were fine. A
  rejected token (401, 403) still keeps its batch: that is temporary, and those intervals matter once it is fixed.
  A 429 now waits for what `Retry-After` asks, in seconds or as an HTTP date, capped at a day.
- afb1b89: Watch the exceptions that kill the process, without changing how it dies
  
  Uncaught exceptions and unhandled rejections are reported with their type, sanitised message and stack
  signature, counted per signature. They are watched through `uncaughtExceptionMonitor`, which Node calls
  before any real handler and which does not count as handling the exception — a plain
  `process.on("uncaughtException")` turns exit 1 with a stack trace into exit 0 with nothing, and one that
  rethrows gives 7. Two processes, one instrumented and one not, are compared in a test.
  
  If the process dies the exception is lost: sending is asynchronous and an uncaught exception does not go
  through `beforeExit`. It arrives when your application survives what it threw, which the README says
  plainly rather than promising otherwise.

### Patch Changes

- d1c1e32: A capture now sends what its order asked for. It used to hand over the whole fine register — every route's name, timing and composition — and count both coverages over all of it. Filtering by dependency needed the black box to keep, per request, which dependencies it touched.
- b7d1cb3: Obey the capture orders the cloud sends. The parser required a number where the contract writes a date, so every order was dropped in silence; and the fine register dated requests with the process clock, so the evidence dated them to 1970 and counted none of them as observed.
- 6877734: Send the profile of a process that did not live a whole minute
  
  The profile's window is a minute wide, for a row-budget reason that has not changed, and `rotate` looked at
  the clock — so shutting down before the minute was up threw away everything the instrumentation had learned
  about what the routes run. A process that keeps restarting is exactly when that matters, and the last
  incomplete minute of every process went the same way. Leaving now closes the window whatever the clock says,
  and the partial window declares the duration it really had.
- 93d0dd1: A capture's evidence now says which request lost its detail or truncated it, not only how many did. The register knew it request by request and only the totals travelled, so a request whose operations had been overwritten arrived with an empty list and read as one that ran nothing.
- 68395bb: In minimal mode a capture's evidence withheld nothing: it copied the route template straight out of the black box. It now goes out as the same digest the batches carry — which also fixes route-scoped captures in minimal mode, whose filter was comparing the cloud's digest against the real template and silently returning empty evidence.
- 07aefad: The dependency key separator is written as an escape instead of a raw NUL byte. No behaviour changes — the
  character is the same one — but the source file stops being binary to git, so its diff can be read in review.
- 51f6510: An error message that says nothing after sanitising is not sent at all.
  
  `product.md` is explicit that when something cannot be processed with guarantees it is omitted rather than
  risked, and the error signatures added in the previous release always sent whatever survived. Now a message
  that comes out mostly `?` is left out — the type and the stack signature still travel — and the text says
  why, rather than leaving a hole.
- 18a259f: Sanitise what a double-quoted SQL identifier carries
  
  A quoted identifier is structural metadata and keeps travelling — it is what makes the label readable — but
  invariant 5 asks for that metadata sanitised, and it was going out verbatim. A name is not always written by
  whoever wrote the query: `SELECT * FROM "${schema}"` builds one from data, and a doubled quote is part of the
  name in SQL, so a whole literal can hide inside one. The same patterns and threshold as an error message now
  apply to it, and a name of which fewer than half the words survive travels as `?`. A name with no values in
  it is unchanged.
- 4a62489: Send a profile even when there is no interval to send with it
  
  `flush` asked whether the interval queue was empty, and the profile queue is a different queue — so a
  profile with no interval to ride on waited for one that might never come. At shutdown there never is one.
- e350236: Do not let an unterminated identifier quote carry the rest of the query out
  
  `normalizeQuery` swallows to the end of the string when a delimiter opens and never closes, which is why it is
  a scanner and not a chain of regular expressions — but the double-quoted identifier branch emitted what it had
  swallowed instead of `?`, so a query with an odd number of double quotes shipped its remaining literals
  verbatim. Every delimiter now follows the same rule. A closed identifier is unchanged.
- c0efa77: Omit three PostgreSQL constructions the scanner only thought it understood
  
  A dollar-quoted body whose tag is not ASCII (`$étiquette$…$étiquette$`) was not recognised as one, and its
  body travelled word by word; a tag that is not valid at all was emitted rather than omitted; and block
  comments, which nest in PostgreSQL, ended at the first `*/` so the rest of the comment shipped verbatim. All
  three now end where the product says they should — omitted, as a hash and a class.
  
  `ErrorFingerprintCache` also keyed anything that was not an `Error` on `String(err)`, which is
  `"[object Object]"` for every object, so the second thrown object came back with the first one's signature
  and the first one's message. It is keyed on what the signature reads now.
  
  The text of a query that carries a comment changes, and so does its hash: a comment now collapses like the
  whitespace it is instead of leaving a double space.
- b4c7e92: Fix the line numbers these packages cite in `docs/product.md`
  
  Comments only, in both packages: the citations pointed at the wrong line, and in the most repeated case at a
  blank one. No behaviour changes.
- c9c4d0a: Clear the Biome warnings in these packages' tests
  
  Test files only — an unused import and two `any` replaced by the interface the test was already asserting —
  so nothing changes in what ships. The build now fails on a warning rather than printing it (ADR 0089), and
  these were the four in the way.
- Updated dependencies [96499ac]
- Updated dependencies [118486b]
- Updated dependencies [652118a]
- Updated dependencies [b4c7e92]
- Updated dependencies [4a62489]
- Updated dependencies [4a2d5ac]
- Updated dependencies [af90c9e]
- Updated dependencies [8489cd3]
- Updated dependencies [bb48212]
- Updated dependencies [83ec804]
- Updated dependencies [82b845a]
- Updated dependencies [3df94fb]
- Updated dependencies [a23b608]
- Updated dependencies [24699a4]
- Updated dependencies [c934696]
  - @downtrace/protocol@0.7.0

## 0.5.2

### Patch Changes

- 55f89d1: The README and the package's own warnings say **instrumentation** instead of "the agent". Two things in Downtrace could be called an agent — this library, and a coding agent that queries and operates the product — and a message someone reads while debugging is the worst place for that ambiguity. The npm name is unchanged on purpose.
- Updated dependencies [ef6a542]
- Updated dependencies [d61306f]
  - @downtrace/protocol@0.6.0

## 0.5.1

### Patch Changes

- df00701: The README now says what the agent observes — incoming and outgoing HTTP, Postgres with pool wait, Redis and runtime health — instead of claiming it only watches incoming HTTP, which stopped being true several versions ago.
  
  It also warns about the one thing that stops an application from starting. `--import` means nothing in your code imports the agent, so a bundler that ships "only what is used" leaves it out: Next.js with `output: "standalone"` dies at boot with `Cannot find package '@downtrace/agent'` while the dependency sits correctly in `package.json`. The fix for Next is a three-line `instrumentation.ts`, measured on Next 15: the agent starts, finds the application's `pg` and reports queries per route, with no change to the Dockerfile or the start command.
  
  And the agent no longer claims to have instrumented `pg` twice. It never did it twice — the guard was there — but the line was written in two places, and a log that lies costs more than no log.
- Updated dependencies [3f87181]
  - @downtrace/protocol@0.5.0

## 0.5.0

### Minor Changes

- d63ac71: `DOWNTRACE_INSTRUMENT` now takes a list, not just an on/off switch: `all` (the default), `none`, or a selection like `pg,http,redis,runtime`. It exists so each observer's cost can be measured on its own, and it lets an operator run only what they want observed. Unknown names are ignored rather than fatal, so a typo cannot stop the agent from starting.

### Patch Changes

- 8fcaf97: Fixes attribution under connection-pool contention. `pool.query()` uses the callback form of `connect` internally, and pg fires a query's callback from the connection's own context, not the caller's: with ten concurrent requests on a pool of two, all twenty queries were charged to two requests and the other eight reported none. The pool's queued callback is now bound to the request that asked for the connection, and a query's callback records into the request captured when it was issued.
- 42c1db4: Halves the cost of attributing pooled queries: one async resource per connection acquisition instead of two, and none at all for work outside a request. `pool.query()` acquires a connection for every query, so that path is on the hot path of any application using a pool.

## 0.4.0

### Minor Changes

- 27ddb88: The agent now measures how long a request waited for a database connection, and reports it against the same dependency as the queries that follow (protocol 0.5). A connection pool with nothing free is what turns one slow dependency into a whole service degrading, and it is invisible in the query's own duration.

### Patch Changes

- Updated dependencies [662e8f5]
  - @downtrace/protocol@0.4.0

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
