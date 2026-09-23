# 0144 — The application reports an error it handled, and the framework's 5xx gets an identity

Estado: aceptado · Fecha: 2026-09-18 · Alcance: público

## Context (gh-596)

ERR-01 names four sources of an error and ADR 0143 built the entity for all four, with two of them feeding it:
an operation that failed inside a request, and an exception thrown outside any request. The other two are this
ticket's — the exception a framework turns into a 5xx, and the error an application reports itself — and the
priorities of `product.md` put them together, third in the list.

They are the two an instrumentation cannot observe on its own. `http.server.request.start` and
`http.server.response.finish` carry the request and the response and **not** the exception, so a 500 arrived
as a status class with no type, message or stack. And an error the application handled — a `catch` that
retries or falls back, an error deliberately turned into a 4xx — leaves nothing to observe at all: from the
outside the request succeeded.

`product.md` left the shape of the call as a pending decision, «Explicit report and the fatal exception», in
two halves. This resolves the first: the call, the context it accepts and how it is sanitised. The second —
whether the exception that kills the process is spooled locally — is ERR-04 and stays open (#598).

## Decision

**1. The call is the tracker's, so that replacing the import is the migration.**
`captureException(error: unknown, context?: unknown): void`, exported from the root of `@downtrace/agent`.
`product.md` offers the choice between a call of our own and one compatible with `captureException` «so that a
migration is a search and replace», and the whole point of «Replacing the error tracker, progressively» is that
a team arrives with a tracker installed. A call of our own would read better in this package and would make
every migration a rewrite of call sites instead of one import line.

The one difference that cannot be hidden is the **return**. A tracker returns an event id; this returns
nothing, because the instrumentation has no identifier to give — an error's identifier is the cloud's digest
of its signature, and the instrumentation does not compute it. Said in the README rather than invented.

What is **not** taken is the tracker's `hint` (`{ extra, tags, user, level }`). That is the
tracker-compatible **SDK** `product.md` explicitly leaves out of scope, as against a compatible call; and
`user` is per user, which IMP-01 forbids outright.

**2. The framework's exception is a middleware the application registers, and not a hook.**
`expressErrorHandler()` returns a four-parameter Express error handler that records and then calls `next(err)`
with the same error, always.

This was investigated before it was decided. Express 5 hands a thrown or rejected handler to `next(err)`,
walks the error-handling layers in registration order and, if nobody answered, gives the error to
`finalhandler`, which `app.handle` builds with an `onerror` option Express fills itself. **Nothing on that
path publishes anything** a library outside Express can subscribe to. That leaves two observation points and
both change what the process does, which is what invariant 2 forbids:

- passing our own final callback to `app.handle` means re-implementing `finalhandler` — a different body, a
  different status when the headers are already sent, a different log;
- patching Express's router, which in 5 is a package of its own, means depending on an internal that has
  already moved once between majors.

ADR 0103 is the precedent and the same judgement: `uncaughtExceptionMonitor` was chosen over a plain listener
because it does not count as handling. A middleware that always calls `next(err)` does not count as handling
either — by construction, not by argument.

**And it costs nothing on the hot path**, which is why there is no bench campaign in this change and no number
written down: it runs only when an error is already travelling, so there is nothing per request to measure. The
overhead budget of ADR 0003/0007/0020 is untouched, and it was not relaxed to make anything fit.

What it costs instead is the one thing worth being plain about: **the «install without touching the code»
default does not cover framework exceptions.** One line does, and the README says so, and the cloud publishes
it as a limit on every list of errors. A project that never registers it keeps exactly today's behaviour: the
5xx is counted and the exception has no identity.

An error that declares itself a client's fault — `status` or `statusCode` in [400, 500) — is passed on and not
recorded. A 404 is an answer, not a failure, and an application that wants one recorded has `captureException`.

Express 4 and 5, which share this shape. Fastify, Koa, Nest and Hono are each their own ticket, when a
participant needs one.

**3. The two sources travel as two more `kind`s of what already travels.** Protocol 0.9.0:
`Operation.kind` and `ProcessException.kind` each gain `framework` and `explicit`. ADR 0017 wrote that
«queries and error signatures share one shape, so the next kind needs no new field», and this is the next kind.
Inside a request it is an operation of the profile, under the route it happened on; outside one it is what the
process saw, with no route, which is the split ADR 0102 already made.

The alternative was an optional `source` field beside `kind`. It would have left `endpoint_operations`'s stored
values untouched, and it would have lost the distinction in that table's primary key — the same signature
reported explicitly and caught by the framework would have been one row.

**4. The context is flat, small, sanitised and bounded, and its bounds are published.** At most **8** keys of
at most 32 characters; each value at most 64 characters after sanitising. A string is sanitised as an error
message is — **including ADR 0084's omission**: a value of which fewer than half the words survive says
nothing and travels as `?` rather than as its own residue. A boolean travels as it is, and **a number comes
out as `?`**: an order id, a user id and a price are all numbers and nothing here can tell them apart, so the
key survives and the value does not. Nested objects, arrays, `null` and functions are dropped.
`DOWNTRACE_MINIMAL=1` withholds the whole thing, and the hash still travels, so the error still groups
(ADR 0105). `DOWNTRACE_QUERY_TEXT=off` does **not** touch it: it is about queries.

**A key has to be a name, and survive the sanitiser unchanged.** The shape alone —a leading letter, then word
characters— only ever looked at the first character, so `order_12345` and `sk_live_4eC39H…` walked through it
literally, and the cloud deliberately does not re-sanitise what arrives. So a key is now also run through
`sanitizeValues` and **dropped when that changes it**. Dropped and not sanitised, unlike a value: `order_?` is
not a name anybody wrote, and half a key names nothing. The schema is not given a `propertyNames` pattern to
match — a pattern would be a restriction rather than an addition, which ADR 0008 does not allow — so this rule
lives in the sender, and the cloud stores what arrives, bounded in size, under `fromService`.

**What the sanitising guarantees, and what it does not.** It replaces what *looks like* a value: anything with
a digit in it, an email, a long run of hex or base64, whatever is between quotes. It cannot recognise a plain
word, so `{ customer: "alice" }` travels whole. The guarantee is therefore «no identifier, no address, no
token», and **not** «nothing about a person»: IMP-01 is a product commitment about what Downtrace measures,
and a call cannot enforce it on prose the caller wrote. The README says that in those words and says whose
job the rest is; an earlier draft of it, of this ADR and of the changeset all claimed the stronger thing.

Only the **first** context seen for a signature in a window travels, and the cloud keeps the first one it is
given, never erasing it — the same rule the text already follows. The reason is arithmetic and not taste: what
travels is counted per signature and not per occurrence, so there is one context to keep and the first is the
one with an instant beside it. And nothing counts what the bounds dropped: a count of dropped keys would be a
fact about one arbitrary occurrence. The bounds are published on the three surfaces instead, which is what
invariant 14 asks — say what is not there, rather than leave a gap.

**5. In the cloud, `source` stays two values and `kind` gains two.** `source` answers «did this happen inside
a request?», and that question has exactly two answers; making `framework` a source would file a framework's
exception outside the request it happened in and lose its route. So the six combinations name ERR-01's four
sources exactly: `(request, error)`, `(request, framework)`, `(request, explicit)`, `(process, uncaught)`,
`(process, unhandled-rejection)`, `(process, explicit)`.

This deviates from a sentence in ADR 0143 — «one more `source` and one more `kind`» — which was a forecast
written before this was looked at, not a contract. Nothing else about that ADR moves: the same tables, the same
opaque identifier, the same budget in signatures, the same refusal counters, the same `new_error` detector.

**6. An error seen two ways is two errors, and it is said rather than deduplicated.** A failed query that then
reaches the framework's error path is listed twice, with one signature and two identifiers, and the counts are
not added. ADR 0083 made exactly this call for the query and its error — «son dos cosas» — and it holds here:
the query failed, and the request died, and one of those is not the other. Deduplicating would need shared
state keyed on the thrown object, which stops working the moment the application wraps the error, which is the
common shape. Published as a limit on every list.

**7. Errors are kept ahead of queries when the per-endpoint cap has to drop something.** The profile kept the
63 most expensive by total time; a reported error takes no time at all, so it would have been the first thing
merged into a bucket the protocol labels a query — on every route with more than sixty-three distinct
operations, silently. Errors first, then time, then the hash, which also makes the cut stable across two
windows. The three kinds of error rank alike: ordering them would be a claim about which way of seeing an
error matters more, and nothing has measured one.

**8. An operation is keyed by kind **and** hash on the instrumentation's side too, and a query still pays
nothing for it.** `endpoint_operations` has always keyed on both; the request context and the profile
aggregator keyed on the hash alone, which was correct while a query's hash could never equal an error's. Now
the same throw can arrive twice with one identity text, and keyed on the hash they merged into whichever kind
got there first — one of the two facts disappearing into the other's count. The end-to-end walk found it, with
three errors where four had happened.

The key is built once per recorded operation, which is once per query per request: the hot path invariant 3
bounds. So **a query keeps its hash as its key**, exactly what it was before this existed, and only the three
kinds of error pay a concatenation — once per failure, not once per call. The alternative was to measure the
allocation with `bench-instruments`, and the cost of a campaign is not worth defending something that can
simply not be spent; a hash is sixteen hex characters, so no query's key can ever read as an error's. What the
cut keeps is decided by the operation's own `kind` and `hash` and not by the key, so ordering is unchanged and
a test fixes it across two windows.

**9. The error fingerprint cache and the profile now exist whatever is instrumented.** They were built only
with `pg` on, because without it no query text is ever looked at. An application can report an error it handled
whatever else is being observed, and before this a process with `DOWNTRACE_INSTRUMENT=http` had nowhere to put
one. The cost is two empty maps and nothing on the hot path: a profile nothing writes into rotates to null.

What does **not** change is the request context, which is still opened only when some dependency observer is
on. Opening one per request for a process that was told to observe nothing would spend on the hot path exactly
what that setting exists to avoid, and it is the first step `bench-instruments` measures. Two consequences
follow, and both are written down rather than left to be found:

- With `DOWNTRACE_INSTRUMENT=none`, a report is attributed to the **process** rather than to the request.
- And **an endpoint exclusion cannot apply to it**, because there is no endpoint to match. This is not the
  exclusion failing: with an observer on —the default, and every realistic configuration— a report rides the
  profile, and the profile is not recorded for an excluded endpoint, so the report is excluded with it. With
  none on, the instrumentation knows no route for the report at all; nothing about the excluded endpoint
  travels —not its template, not its counts, which are still excluded from the aggregates— but the error's own
  text does. The switch that withholds text is `DOWNTRACE_MINIMAL=1`, and the README now says exactly this
  instead of the sentence it had, which promised that the exclusions covered both calls without qualification.
  A test pins the behaviour, so the sentence and the code cannot drift apart.

The alternative was to honour exclusions on the report path, which means knowing the route at report time,
which means opening a context per request in a process configured to observe nothing. That is the spend above,
to close a hole that exists only in a configuration that contradicts itself: observe nothing, but report.

**10. This lands the schema, the cloud and the instrumentation in one pull request. That is a single-case
exception to ADR 0008, and not a supersession.** ADR 0008 stays `aceptado`, is not marked superseded, and its
rule — «un tiquet para protocolo y cloud, otro posterior para el agente, nunca en el mismo PR ni en la misma
publicación» — stands for the next change. What is recorded here is that this one change was accepted against
it, with the reason and the guard that replaces what the rule was buying.

What the rule protects is one thing: no published instrumentation may emit a field before the deployed cloud
accepts it. With `additionalProperties: false`, a 0.9.0 batch against a cloud that predates this merge is a
**400 at the door** — the batch discarded, and the intervals and profile riding with it lost. The mechanism
ADR 0008 itself names still orders the two here: merging deploys the cloud (Coolify, on every push to `main`
that touches `cloud/**`) and publishes nothing, while npm publication waits for the versions PR that
Changesets opens afterwards.

**The guard, because a mechanism is not a check.** Before merging the versions PR that publishes
`@downtrace/agent` 0.9.0, the deployed cloud is verified to be at or after this change's merge commit:
`GET /healthz` on the deployed cloud answers `{"status","version"}`, and `version` is the first seven
characters of `SOURCE_COMMIT`, which Coolify injects at build (`cloud/Dockerfile`, `resolveVersion` in
`cloud/cmd/downtrace/main.go`, and `cloud/README.md`'s deployment row). If that is not this merge commit or a
later one, the publication waits.

It is **the human's check and not CI's**, and that is the part worth knowing: the public mirror publishes
`packages/` and never sees `cloud/`, so no workflow on the publishing side can look at the deployed cloud at
all. Nothing automates this; it is one `curl` before one merge.

What is lost by not splitting is a reviewer's ability to read the two halves apart, and a window in which the
cloud is known-good against the old instrumentation before the new one is written. What is gained is that
ERR-02 and ESC-13 are verified end to end in one change instead of being half a capability across two.

## Alternatives

**A call of our own instead of the tracker's shape.** Above, decision 1.

**Accepting the tracker's `hint` object.** It is the compatible SDK `product.md` puts out of scope, it carries
`user`, and it would make the context a nested shape whose bounds nobody can state in a sentence.

**An automatic hook for the framework's exception.** Above, decision 2: both available points change what the
process does, and one of them depends on an Express internal that has already moved between majors. If a
future Express publishes on `diagnostics_channel`, this decision is worth revisiting and the middleware stays
as the way to cover the versions that do not.

**Capturing every error that reaches the error handler, including 4xx.** It would fill a project's signature
budget with `NotFoundError` from the first hour. The tracker's own default draws the same line.

**A new top-level array on the batch for reported errors.** A second way for an error inside a request to reach
the cloud, and a second thing for the cloud to merge, for no reader's benefit.

**Counting the context keys that were dropped.** The count would be about one arbitrary occurrence, because
what travels is per signature. The bounds are published instead, which is true of every occurrence.

**Sending the latest context rather than the first.** The latest has no instant beside it; the first sits next
to `firstSeenAt`, which is the field the whole entity exists for (ADR 0143).

**Deduplicating the failed operation against the framework's exception.** Above, decision 6.

**Splitting this into two pull requests, as ADR 0008 says.** Above, decision 10, with what each side costs.

**Superseding ADR 0008 instead of excepting it.** Rejected deliberately: one change that can order its own
deployment is not evidence that the rule is wrong, and a rule superseded on one convenient case is a rule
nobody applies afterwards. ADR 0008 stays as it is.

**Measuring the per-operation allocation with `bench-instruments` instead of removing it.** A campaign to
defend a cost that can simply not be paid. Removed instead; decision 8.

**Sanitising a context key instead of dropping it.** `order_?` is not a name anybody wrote, and a reader
cannot tell a sanitised key from a real one. Dropped; decision 4.

## Consequences

- ERR-02 and ESC-13 leave the list of uncovered commitments in `scripts/check-commitments.sh`. ESC-13 is walked
  end to end: the reference app catches a failed provider call, reports it with a context and carries on, and
  the error is read with one identifier on the API, on the page and through the real MCP server over stdio,
  with the context sanitised — `operation: "authorize"` and `willRetry: "false"` survive, `attempt` arrives as
  `?` — and with nothing per user anywhere in it.
- The reference app depends on `@downtrace/agent` now, which is a workspace sibling and changes nothing about
  what it publishes, since it publishes nothing. Both calls do nothing when the instrumentation is not loaded,
  which is how the benchmark's baseline rounds run, so both variants of a campaign carry the same module and
  the delta still measures the instrumentation.
- The v0 protocol moves to 0.9.0. Only additions, all optional, and the batch's `protocol` enum keeps every
  published minor, so every instrumentation in the wild stays valid and the cloud reads its batches exactly as
  before — there is a test that ingests one and asserts it.
- An error an application reports outside a request has no route, and that is the answer rather than a gap. A
  process with `DOWNTRACE_INSTRUMENT=none` reports every error that way; the README says so.
- **Before the versions PR that publishes `@downtrace/agent` 0.9.0 is merged**, check that the deployed cloud
  is at or after this change's merge commit: `curl https://<cloud>/healthz` and compare its `version` —the
  short `SOURCE_COMMIT`— with that commit. A 0.9.0 batch against an older cloud is a 400 at the door, and the
  mirror that publishes to npm cannot see `cloud/` to check it, so this one is the human's.
- Found along the way and **not fixed here**, because it is not this ticket's: every batch that carries a
  capture's progress report is refused by the cloud with a 400, because the instrumentation writes `startedAt`
  as `performance.timeOrigin + performance.now()` — a float — where the schema asks for an integer. It has its
  own ticket. The end-to-end walk still passes: the evidence travels on its own path and is accepted.
