# 0202 — The estimate says what its own read could not do, and never «no capture» for it

Estado: aceptado · Fecha: 2026-09-28 · Alcance: público

## Context (gh-737)

When there is no estimate, the report says the refusal that is true (ADR 0186): a reader sent to ask for a
capture they already have touches the wrong thing next, and invariant 14 prices it. Three of the estimate's
paths returned a sentence that may not be true, and all three ended in the same words, `NoEvidence`, «no
capture covers this finding's window».

- **The store failed.** `EvidenceForFootprint` returning an error was logged, and the report said no capture
  covers the window — a state the report did not know, said as a fact about the data. The pool attribution's
  read, the route's dependency windows (ADR 0200), took the same wrong sentence on its error.
- **The detail could not be read.** The unmarshal of a capture's requests that failed skipped the capture
  without a log and without a count. When it was the only capture, the report said «no capture covers» of a
  capture that does cover the window: a `catch` that swallows, which `CLAUDE.md` forbids. That a capture of
  another shape can be stored at all is possible, because the ingest does not validate against the schema
  (gh-459).

The mutation audit of gh-653 saw the first: swapping the error path's refusal for another kept the tests
green, because the fake store could not fail the read and no test stored unreadable detail.

## Decision

**1. The read's failure is its own sentence, and the report is not failed for it.** A new refusal,
`NoEvidenceRead`: the read of the captures covering the window failed, so whether a capture covers it is not
known. It is returned where the read fails — the evidence read and the pool attribution's read, which are the
same fact: a read of the store that did not come back. The report keeps being served, and that is deliberate,
although every other read of the report fails the report: those compose the document itself — the finding's
row, its incident, the diff, the episodes, the freshness, the assessments — and the report without one of
them is not the report. The estimate composes one field of a block whose unknown state is explicit by design:
`affected` is always null with its reason, and the reason exists to say why there is no estimate. A reader
who loses the whole report because the captures' join failed loses the diff they came for, to learn that one
of its sections could not be read; the sentence gives them the document with the true reason in the one place
the report says its unknowns. The retry is the same either way: the next request reads again.

**2. Detail that cannot be read is logged, counted and said — never swallowed.** A capture whose requests do
not parse is written to the log by its identifier, and the loop counts it. If every capture of the window is
unreadable, a new refusal, `EvidenceUnreadable`: a capture covers the window, but the detail it kept could
not be read, so its requests cannot be judged. The reader is told there is a capture — they can go to it and
see for themselves what shape it is in — instead of being sent to request one they already have. If a
capture yields an estimate, the estimate is published out of the readable one, as the loop already prefers
it, and it says how much of the window it is not over: an additive number, how many of the window's captures
could not be read, which the page prints beside the estimate and its capture. The estimate's method already
says it is counted over the requests one capture kept, a sample of the window and not the window; the number
is the window's other half, named. The field is additive on a published answer: a consumer that reads it
sees one more number, one that does not reads what it read before.

**3. `NoEvidence` is left for the one case it is true of.** The read came back, and no capture covers the
window. Each of the fourteen refusals of `cloud/internal/impact` is reached by a case of the enumeration,
which now includes the two new ones.

## What it does not change

The ingest, which does not validate captures against the schema (gh-459): this decision says the truth about
what could not be read; whether a capture of another shape may be stored at all is the ingest's. The window
whose readable captures were all refused and whose other one could not be read: the refusal stands as the
sentence of what the readable ones kept, and the unreadable one is in the log. The agent, which passes the
answer through as it does the rest (ADR 0185), and the page, which prints what the resource publishes.
