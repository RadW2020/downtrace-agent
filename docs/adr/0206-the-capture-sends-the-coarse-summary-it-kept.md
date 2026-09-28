# 0206 — The capture sends the coarse summary it kept

Estado: aceptado · Fecha: 2026-09-28 · Extiende el ADR 0067 · Alcance: público

## Context (gh-629)

ADR 0067 built the coarse register — the last few minutes of aggregates per second and per endpoint, plus the
process's event loop delay — and ended on a promise: «cuando existan las capturas (gh-277), `snapshot()` es lo
que congelan». The captures exist now, and `product.md:122` says what a capture freezes: «the fine detail
before and after the instant of detection, reference samples and the coarse summary of the previous minutes».
But nothing read the register: it was written on every request and never sent, so the black box was half the
sentence `product.md:94` gives it («makes it possible to see how something detected late began»). The event
loop series had a second gap: nobody fed it, because nobody sampled the loop at the cadence the series demands,
one slot per second.

The ticket asked to make the summary do what the product says, or to document why not. Making it work costs a
field, a column and a one-second timer; documenting the gap would leave the product sentence short on purpose.

## Decision

**1. The capture sends the summary whole.** The evidence gains a `coarse` field: the snapshot of the register
frozen when the capture is sent — per second, per endpoint, plus the event loop series. Whole, and not filtered
by the capture's footprint: the summary is the process's, and what the other routes were doing is exactly the
context the captured one needs. Its size is bounded by the register's own caps, which the protocol pins (129
routes at most, 300 seconds each), so it cannot compete with the per-capture budget, which counts requests and
the summary is not one.

**2. The routes are named like the fine register's are.** The register keeps the real templates — the black box
never leaves the process — and the capture is the moment they are named for the outside, through the same
naming the fine detail already uses, which in minimal mode is the digest (ADR 0105).

**3. The event loop is fed once a second, and a second nobody sampled stays absent.** A timer in the agent,
alive only while the runtime observer is on — when it is off, nobody samples the loop, and an unsampled second
must not read as an idle one. The timer asks the sampler for the worst delay of its own histogram in the last
second, and a second with no sample sends nothing for the loop. The tick goes through the same guard as the
rest of the self-observation (invariant 2): a bug in feeding the summary must not reach the application.

**4. The cloud stores it as it arrived and serves it under `fromService`.** A `coarse` JSONB column beside
`reference`: the cloud does not re-describe it, and the read serves the stored document back. Absent means the
sender is older than the summary, and the read says nothing about one — the same rule the reference samples
already obey (invariant 14).

**5. The protocol version does not move.** The field is additive to 0.9.0, which the schema already carries and
the packages have not published, and the gate that keeps the schema and the packages in step (ADR 0019) does
not admit a new minor while a release is pending. The change rides the pending 0.9.0, and its changeset stays at
the bump that cannot move the package version, since the version series in the schema does not grow.

## What it does not change

The register itself, its budget and its arithmetic (ADR 0067); the per-capture budget, which counts requests and
sees the summary the way it sees a header; the flush cadence, which stays a decision of the fine detail; the
capture triggers, which are unchanged and now freeze more of what the process already kept. An older agent sends
what it sent: the field is absent, the column is null, and nothing in the read changes shape.
