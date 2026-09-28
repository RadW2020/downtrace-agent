# 0208 — What does not fit in the signature cap is counted and said

Estado: aceptado · Fecha: 2026-09-28 · Alcance: público

## Context (gh-659)

A process exception travels as a signature, and there are two caps of 32 distinct signatures: `MAX_SIGNATURES`
in the register's window, and `MAX_EXCEPTIONS` in the sender's accumulation while batches do not land. Past
either one, a new signature is not admitted — the caps stop admitting rather than evicting, because a process
throwing unbounded distinct signatures is the one an eviction would thrash — and nothing counted it. A process
that saw 40 distinct exceptions told the cloud 32, and the other 8 were read as errors that did not happen.

That reading is the one COB-01 exists to forbid: every result says what was left out, and distinguishes loss
for budget from the absence of errors. The invariant is 14: no data does not mean no errors. The batch already
says so for the other losses — `droppedBatches`, `failedBatches`, `rejectedBatches`, `internalErrors` — and
silence was the one loss it did not.

## Decision

1. **It is counted, in `AgentResources`, as a new optional field `droppedExceptions`.** No existing field
   is honest for this: `droppedBatches` counts batches, and an exception that did not fit is not a batch that
   was thrown away, so putting it there would conflate two losses the reader cannot untangle. An existing
   field is also not where the cloud accumulates it: the instance's counters live beside `dropped_batches`,
   add up across batches, and are served where those are served — the status resource, and the page's
   measured-resources column.

2. **It counts occurrences, never signatures.** A signature that did not fit cannot be counted as distinct
   without remembering it — a buffer that grows with the very flood the cap exists to survive, which the
   budget does not allow (invariant 3). An occurrence is exact and costs one increment: every throw that was
   not admitted, at either cap. It bounds what was lost from both sides — at least one more signature, at most
   as many — and it is the number that says how much error traffic the cloud did not see, which is the question
   COB-01 asks. Counting both would have meant an approximate signature count beside an exact occurrence
   count, and the approximation was a lie in either direction, so only the exact one travels.

3. **The counter covers both caps, and rides the batch until the batch lands.** The register counts a throw
   that its window did not admit and hands the count over with the window's take; the sender counts a signature
   its accumulation did not admit, with the occurrences it carried. Both join the sender's `since` counters —
   the ones that are reset when a batch **lands**, not when it is sent — because a counter that dies with its
   batch lies downwards, and that is the direction that makes a losing instrumentation look healthy (gh-243).
   A cloud that never lands batches never lands the count either, and says nothing about it: that loss, like
   the exceptions it would have carried, is the one a process that leaves cannot report.

4. **The cloud accepts it, adds it up per instance, and serves it where the other counters are served.** The
   column on `instances` accumulates like `dropped_batches`; a batch that does not say it — an older
   instrumentation — adds nothing and erases nothing, which is the reading the field is for: absent is «did
   not say», never «nothing was lost».

5. **It is protocol 0.9.0, still unpublished, and the cloud goes first as ADR 0008 says.** 0.9.0 is the minor
   that is still pending its release — nothing on npm stamps it yet — so the field joins it rather than moving
   the protocol a second time before the publish, which is exactly the move the guard `check-protocol-version`
   refuses (ADR 0205). The schema and the cloud that accepts it deploy on the push to `main`; the agent that
   sends it publishes with the pending 0.9.0 release, which comes after. A new agent against the old cloud is
   not broken but is **refused**: `additionalProperties: false` answers 400, the agent says so once and keeps
   running, and the batches it sends are the ones a cloud that had not learned the field cannot read. That is
   ADR 0008's own rule — an agent ahead of its cloud receives a 400 at the door rather than lose data in
   silence — and the ordering is what keeps it from being the normal case.

## What it does not change

The caps, the stop-admitting-rather-than-evicting, the running totals and their own bound (ADR 0179), and the
memory arithmetic the black box checks itself with (ADR 0067): the counters are one pre-sized number each, in
the register and in the sender, and they grow not with the traffic they count but with nothing, so they are
not in the bytes the registers hold and say. The loss a running total does not cover — a signature past the
bound travels without its total — is a different loss, said where its number is shown, and is not this one.

## Consequences

The batch says, per batch that lands, how many exception events the instrumentation discarded at its caps
since the previous one, and the instance's accumulated total is served with the rest of what the
instrumentation says about itself. A reader of 32 signatures and 8 discarded occurrences knows the world of
errors was wider than what was seen, by at least one signature and by no more than eight, and that neither
number is a claim about what the unseen ones were.
