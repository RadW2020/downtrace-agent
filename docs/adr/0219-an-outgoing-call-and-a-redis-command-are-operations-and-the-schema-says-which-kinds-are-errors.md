# 0219 — An outgoing call and a Redis command are operations, and the schema says which kinds are errors

Estado: aceptado · Fecha: 2026-10-02 · Sustituye, del ADR 0212, la lectura de `inRequest` como «`Operation.kind` menos una query» · Alcance: público

## Context (DT-16)

The structural footprint of a request is the sequence of what it did — queries by fingerprint, outgoing calls by
host, Redis commands — with their counts, timings and overlaps, and ATR-01's own example is two calls of 200 ms
that overlap. The protocol had one kind of operation a route runs, `query`, beside three kinds of error. Calls and
commands travelled only as counters per dependency: enough for the degraded-dependency detector and for «calls per
request», and absent from the profile and from the black box. So the diff of a finding could not say «three calls
to the provider where it made one», the timeline of a capture showed a gap where the slow call was, and the
attribution of the critical path left that time as uncovered.

ADR 0017 left the shape ready for this — «one `operations` with a `kind` (`query`, `error`, and whatever comes)» —
and two things stood in the way of using it:

- **What an error is was defined by exclusion.** The cloud filed every kind but a query as an error, and the guards
  of ADR 0212, in both languages, compared the in-request sources of error with «`Operation.kind` but a query». A
  new kind would have reached the list of errors (ERR-01) and become a source of error nobody connected.
- **The black box's operations carry no kind, and they are not all queries.** The published instrumentation
  (0.8.1, protocol 0.8.0) writes there every operation it records, the error signature it records beside a failed
  query among them, without saying which is which. «An operation without a kind is a query» is false for every
  evidence that exists.

## Decision

**1. Two kinds of operation.** `Operation.kind` gains `call`, an outgoing HTTP call identified by its method and its
host, and `command`, a Redis command identified by its name and its server, both with `x-since` 0.9.0. Their
normalised text is a word and the place it went — `POST api.stripe.com`, `HGETALL cache:6379` — and never a path, a
query string, a key or an argument (invariant 5). The schema enforces the part of that it can see: for these two
kinds, `text` matches `^[A-Z][A-Z0-9._-]* [^\s/?#]+$`, so a label carrying a path, a query string or anything after
the place is a 400 at the door. It cannot tell a server from a key without a space in it; that stays where ADR 0017
put normalisation, in the instrumentation. The text is absent in minimal mode and when the name of the dependency
is withheld, and the hash stays the identity. The cap does not move: 63 operations and `(other)` per endpoint, shared
by every kind.

**2. The schema says which kinds are errors.** Beside the enum, as `x-since` is, `x-error` gives one boolean per
value, and its keys are the enum: `error`, `framework` and `explicit` are errors, and `query`, `call` and `command`
are what the route ran. `InRequestErrorSource` holds the values `x-error` marks as errors. This replaces ADR 0212's
reading of the in-request list as «`Operation.kind` but a query», in its decision and in its guards: they now compare
the list with `x-error`, and a kind added without saying whether it is an error fails them. A validator in strict
mode has to be told `x-error` is a keyword, as it is told the other annotations.

**3. The evidence names the kind of each operation.** `CapturedOperation.kind` is optional and borrows the batch's
enum, which `make gen` refuses to let drift. **Absent means the sender did not say, never a query.** The ticket
approved «absent means query»; its own review found the premise false (the second point of Context), and a reader
that took an older sender's error signatures for queries would be naming what it was not told (invariant 14). So
the cloud reads an operation without a kind exactly as before: by its hash, with no kind named, in the attribution
and on the page. The cost is a field on every operation a new sender writes, queries included.

**4. The version.** Both additions ride the 0.9.0 that is not published yet, as `coverage.shed` (ADR 0210),
`agent.errorSources` (ADR 0212) and `dependenciesTruncated` (ADR 0215) did. The version guard refuses a second minor
before the pending one is published, and ADR 0008 says not to want one.

**5. What the cloud does with them.**

- The classification is written out both ways, by name. «Everything but a query» filed the first call as an error,
  and «only these three» would leave a kind of error the schema gains out of the list in silence. A test enumerates
  the generated list of kinds, fails on one that is unclassified, and compares the classification with `x-error`.
- A call or a command never reaches the list of errors, not even one that failed: its failures are counted on the
  operation, in `errors`, as a failed query's are.
- Ingest stores them beside the queries, in the same table, whose `kind` is text: no migration.
- The diff compares them as composition, labelled by kind, with the text under `fromService` (ADR 0036).
- The attribution of a capture identifies an operation by its kind and its hash, and names the kind; the timeline of
  the capture's page names it beside the hash.
- `operation-multiplication` counts calls and commands, **kind by kind**. The condition is that each execution still
  costs what it cost, and a mean over a 1 ms query and a 200 ms call moves with the mix and not with the cost: a
  route that went from one call per request to five, each as slow as before, would read as every operation having
  got slower. The mean of a kind is the cost of one of its own executions (invariant 7). Every kind that holds is
  said.

**6. The budget.** The rows of a profile are bounded per endpoint as they were, so the worst case does not move:
calls and commands take slots the queries left free. What moves is how quickly a project gets near its daily budget.
ADR 0017's example, 20 routes of 8 operations, is 230 400 rows a day; with two calls per route it is 288 000. Their
rows are queued in the same batch as every other row and pay the same budget, enforced as before (invariant 8).

**7. The order.** Protocol and cloud in this change; the instrumentation that records calls and commands, in the
profile and in the black box, is the next ticket, once this cloud is deployed (ADR 0008).

## Alternatives

**Absent means query, as approved.** Compact — a sender would write a kind only where it is not a query — and false
for every evidence already stored and every instrumentation already installed.

**Absent means query only in an evidence stamped 0.9.0 or later.** The instrumentation on the main branch already
stamps 0.9.0 and still writes error signatures without a kind. Publishing it before the instrumentation ticket would
put a sender that breaks the contract into the world, and a reader would have to know which builds to distrust.

**Keep the classification in the guards' tests.** The non-error kinds written as a list in two tests, in two
languages. The fact would live where no consumer of the contract can read it, and the contract would not say which
of its kinds are errors.

**A definition per class, composed into `Operation.kind`.** An `anyOf` of the error kinds and the others. The schema
would say it structurally, and the generated Go type of `kind` would stop being a string.

**One mean across every kind for the pattern.** It is what the code did over queries, and it moves with the mix
the moment the mix has two kinds in it.

**A field of its own for calls, beside `operations`.** ADR 0011's mistake, which ADR 0017 exists to avoid.

## Consequences

- Every batch and every evidence that was valid still is: the fixtures say so and a test holds it. A sender older
  than this sends neither kind nor the field, and reads as it did.
- Until the instrumentation sends them nothing new arrives, and the diff, the attribution and the timeline read as
  before.
- A validator in strict mode registers one more keyword.
- The `(other)` bucket stays labelled `query` whatever it merges. Once calls share the cap, it may merge calls too;
  what it merges is the instrumentation's to decide, and the label does not change here.
- The pattern of a new error and the hypothesis of a failing operation still read only the kind `error`, not
  `framework` or `explicit`. That predates this and is a ticket of its own, DT-42.
