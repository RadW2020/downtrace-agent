# 0215 — The evidence marks the rows whose dependencies did not fit

Estado: aceptado · Fecha: 2026-09-30 · Alcance: público

## Context (gh-902)

The matcher of a capture of a dependency admits every row that names the dependency and every row whose list of
dependencies was truncated: a dependency absent from the list is not proven not to have been used, and stopping
of matching those rows is the error invariant 14 forbids (gh-825). That matching is right, and it stays.

What comes out does not say it. A captured request carries only `truncated` (operations) and `detailLost`, a row
of the reserve travels with both false, and `coverage.truncated` does not count them. A request that touched five
HTTP hosts and never touched postgres travels in a capture of postgres indistinguishable from one that waited on
postgres, and the population the cloud attributes over is inflated without saying so (invariant 7, ATR-01).
gh-861 asked that the evidence count such rows as incomplete; the criterion came back rewritten as «and the
evidence counts it» (PR #874) and was taken as met.

## Decision

**1. The field.** `CapturedRequest.dependenciesTruncated`, an optional boolean: absent means false, as with
`truncated` and `detailLost`. Present when the row's list of dependencies was truncated: what travels is what
fit, and a dependency not in the list is not proven not to have been used (invariant 14). It is a field of its
own, because `truncated` means incomplete operations and the cloud reads it as such.

**2. The counter.** `coverage.dependenciesTruncated`, an optional integer at zero or above, beside the other
coverages, counting the evidence's rows that carry the mark. Optional for the same reason: a sender older than
the field sends nothing, and the absence is not a zero.

**3. What the cloud does with it today.** It validates it: the cloud compiles the schema of the contract, and a
mark that does not validate is a 400. It does not keep the counter: `coverage` is mapped column by column in the
store, and keeping it asks for a migration, which is a ticket of its own, as the body of gh-902 already said. The
mark of each request is kept: the requests travel as they arrive and are stored as JSON.

**4. The version.** It rides the 0.9.0 that is not published yet, as `coverage.shed` did (ADR 0210) and
`agent.errorSources` did (ADR 0212): fields are only ever added, always optional, and the minor is the one
published, not one bumped per field.

**5. The order.** Protocol and cloud in this PR, which references gh-902 and does not close it. The
instrumentation that fills the mark from the ring and from the reserve — the rows already carry it internally —
is the other half, a separate PR that closes the ticket, once this cloud is deployed (ADR 0008).

## Alternatives

**Stop matching the rows whose list was truncated.** The error invariant 14 forbids: a dependency absent from
the list is not proven not to have been used, and that line is exactly the one gh-825 drew.

**Reuse `truncated`.** It means incomplete operations, and the cloud reads it as such: overloading it would
count rows whose operations are complete in a coverage that promises operations, and a reader of the counter
could no longer tell the two losses apart.

**Keep the counter from the start.** A column and a migration for a number nobody reads yet. The mark travels
validated, and the column comes with the ticket that reads it.

## Consequences

- Until the instrumentation sends it, every evidence is without the mark and everything reads as it did: the
  existing fixtures validate as before, a test holds it, and an older sender's evidence is accepted as it was.
- The mark lives on the shape of the captured request, which is the one the evidence and the reference samples
  share: wherever a row travels, it carries what the row is, whatever capture brought it in.
- The counter is validated and not kept until the migration ticket: the number is in the contract and in no
  table yet.
- gh-902 stays open until the second PR fills the mark; this one references it. How the cloud uses the mark in
  the attribution, if it needs to, is a ticket of its own, as the body of gh-902 decided.
