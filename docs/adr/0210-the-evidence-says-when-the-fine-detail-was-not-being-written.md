# 0210 — The evidence says when the fine detail was not being written

Estado: aceptado · Fecha: 2026-09-29 · Alcance: público

## Context (gh-782)

A capture taken while the instrumentation is shedding the fine detail — by memory or by latency — arrives
with zero observed requests and the old requests that the frozen ring still held, attached. Nothing in the
evidence says that the detail was not being written, how long that lasted, or why. Whoever reads it sees
«zero observed requests» on a route that may have been busy the whole time.

The cloud made it worse than that was: the capture's end adds the observed and the attached, and with zero
observed and attached detail that lost nothing, the capture ended **complete**. With nothing attached it
ended **empty** with «no requests reached this scope», which the shedding makes false. CAP-01 asks a capture
to end with complete evidence, partial evidence or no evidence — and when the evidence is missing, to say
what is missing, whether a future capture could provide it and what limitation would still be unresolved
(`product.md:192`). Invariant 14 is the line under both: no data does not mean no traffic.

## Decision

1. **The field.** `coverage.shed`, optional in the capture's evidence: `{ "ms": integer ≥ 1, "reason":
   "latency" | "memory" }`. Present when some part of `[startedAt, endedAt]` the instrumentation was not
   writing the fine detail — neither the ring nor the reserve. `ms` says how long that lasted, rounded up.
   `reason` is the last reason in force inside the window, and it is the batch's
   `agent.resources.shedReason` enum, not a copy: the generator refuses a drifted one. Absent when there was
   no shedding, when the shedding came from configuration (`DOWNTRACE_SHED`, the benchmark) and the
   instrumentation never decided it, or when the sender predates the field: all three read as «the evidence
   does not say». It goes in the unpublished 0.9.0, as ADR 0008 orders.
2. **The capture is accepted, not refused.** The shedding can end before the window does, the coarse
   register keeps measuring, and the protocol has no way for an instance to refuse an order. Saying it in
   the evidence is what CAP-01 asks for.
3. **The cloud.** The shedding is stored with the evidence, in two nullable columns whose checks say what the
   schema says; null is the declaration of absence, and it is never backfilled, because backfilling would
   invent a measurement. In the capture's end, an evidence with `shed` and some request ends **partial**,
   never **complete**; with no request it ends **empty**. In both cases the reason says how many seconds of
   the window the detail was loose and why, that the requests of that time are not in the evidence and do
   not count as observed, that the coarse summary does count them, and that a capture asked for once the
   shedding stops can carry them where repeating it while it sheds cannot. That reason is the one the page,
   the API and the MCP already read.
4. **The order.** Protocol and cloud in this change. The instrumentation that measures `ms` — with its own
   clock, on each change of keeping the fine detail — and sends the field is the other half, a separate
   ticket (ADR 0008: the cloud accepts a field before any sender emits it).

## Alternatives

- **Refuse the capture while shedding.** A refusal cannot say «shedding for the rest of the window» apart
  from «shedding for its first minutes», the protocol has no path for an instance to refuse an order, and
  the refusal would hide the attached detail that was still there.
- **A boolean `shed`.** Without the duration and the reason, a reader cannot tell a one-second blip from a
  whole window, or latency from memory, and a boolean cannot accumulate what the reason has to say.
- **A JSON document beside the counts.** The shape is fixed and small — a number and an enum — and the
  evidence keeps its coverages as columns; the shedding is a coverage, and it gets the same shape.

## Consequences

- Until the instrumentation sends it, the field is absent and every capture ends exactly as before: the
  existing evidence tests are untouched and the old rows read as «not declared».
- `complete` no longer means «the window is fully shown» for an evidence that declared a shedding, which is
  the reading CAP-01 forbids.
- Readers of the capture's reason pick up the new sentence with no surface change: the page, the API and
  the MCP read the one reason the store writes.
