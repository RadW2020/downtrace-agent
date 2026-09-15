# 0139 — The CPU margin is accepted with the series as its guard, and Postgres is where it would be recovered

Estado: aceptado · Fecha: 2026-09-15 · Resuelve el tiquete que el ADR 0020 dejó abierto sobre el margen de CPU; no cambia ningún presupuesto · Alcance: público

## Context

Invariant 3 gives the instrumentation 3 percentage points of CPU. Seven measurements on three machines put it between +2.25 and +2.79 pp: the three of ADR 0020 on 2026-09-07 (+2.701, +2.724, +2.670), and the mirror's kept campaigns of 2026-09-14/15 (+2.253, +2.334, +2.785, +2.632, +2.742, +2.658, +2.490). The margin is between 0.2 and 0.75 pp, and ADR 0020 left it as a ticket: «the first number measured in the production architecture, at 91 % of the budget». Between the first measurement and the last, `packages/agent/src` went from 14 files and 1,343 lines to 30 and 5,409, and the total did not move; nothing measured said why, or where the cost was.

gh-570 built the instrument (#588): the bench's sink reads the agent's own hook estimate (ADR 0080), `DOWNTRACE_SHED` holds a floor under the shedding level so the two halves of the black box can be weighed on their own, `bench-instruments` has seven head-to-head steps, and the mirror runs it on demand (ADR 0134). This ADR is its reading.

## What was measured

**By observer.** Two `instruments` runs on the mirror, 9 rounds per side × 20 s × 200 rps, permutation gate 0.05/7 = 0.0071 (ADR 0027). The first ([run 34995028029](https://github.com/RadW2020/downtrace-agent/actions/runs/34995028029), whose report the keep step of that day lost, gh-590; its table is in the job log) and the second, kept as `2026-09-15T18-44-20Z-instruments-0.8.1-a1ab0eb.json` on `bench-reports`:

| Cost of | run 1 ΔCPU (pp) | ± 2 s.e. | resolved | run 2 ΔCPU (pp) | ± 2 s.e. | resolved |
|---|---:|---:|---|---:|---:|---|
| the agent itself (`DOWNTRACE_INSTRUMENT=none` against no agent) | +0.964 | 0.071 | yes | +1.106 | 0.604 | no (p 0.0078) |
| runtime health | +0.127 | 0.198 | no | −0.115 | 0.285 | no |
| **postgres** | **+1.602** | 0.421 | **yes** | **+1.506** | 0.472 | **yes** |
| outgoing HTTP | +0.065 | 0.485 | no | −0.018 | 0.528 | no |
| redis | +0.091 | 0.162 | no | +0.290 | 0.227 | no (p 0.0195) |
| the fine detail (`DOWNTRACE_SHED` fine → nothing) | +0.199 | 0.296 | no | +0.403 | 0.665 | no |
| the profile (`DOWNTRACE_SHED` profile → fine) | −0.063 | 0.490 | no | −0.187 | 0.434 | no |

The rows add up to 2.85 and 3.0 pp against campaign totals of 2.49–2.79: the decomposition accounts for the whole. The one row the machine resolved in both runs is **Postgres, 1.5–1.6 pp**. The agent's core — request context, aggregation, the coarse register, transport — is **about 1 pp**, resolved once and at the gate the second time. Everything else is within its own noise: the three other observers, and the two halves of the black box that the 3,950 new lines mostly are.

**By phase.** The campaign kept as `2026-09-15T17-54-49Z-agent-0.8.1-a1ab0eb.json`: the agent's own estimate of its hooks is ~0.032 ms of CPU per request (one hook in sixty-four timed, ADR 0080), against 0.1245 ms per request measured (Δ 2.49 pp at 200 rps). **About 26 % of the measured cost is inside the hooks; 74 % runs outside them** — context propagation, the transport and its serialisation, timers, the pressure the agent puts on the collector. It is what ADR 0009 measured in another form: «el coste medible está en el `enterWith` por request, no en el envoltorio de pg».

## Decision

**The margin is accepted, and the budget does not move.** Three things hold it:

1. **The series is the guard** (ADR 0134). Every merge that touches the instrumentation measures on the mirror after it lands; the noise between rounds is a standard error that shrinks with the rounds (ADR 0137), and an `ok` the machine could not resolve no longer passes (ADR 0138). A change that moves the cost by what the margin is worth shows up within a day, as a `fail` or as an unresolved `ok`, never as a green.
2. **The instrument stays armed.** `mode: instruments` on the mirror answers «which part» in an hour whenever the series moves, and the report of every campaign says what share of the cost is inside the hooks.
3. **Postgres is where margin would be recovered**, and gh-592 measures inside it before anything is changed: what the 1.5 pp are — the context capture and binding per query, the fingerprinting of the query text, the wrapping of the pool — and what the 74 % outside the hooks is, with a CPU profile of a round. Changing behaviour to buy margin waits for that reading; changing the budget is the human's decision and is not proposed.

**The hypothesis of gh-570 is answered**: the quadrupling of the code did not move the cost because it went into the black box, and the black box's two halves cost less than the noise can see (+0.2 to +0.4 pp for the fine detail, nothing measurable for the profile). What costs is what ran before those lines existed: the Postgres observer and the core.

## Alternatives

- **Recover margin now, in the Postgres observer.** The obvious lever, and the one gh-592 exists for — but the table says which observer, not which line, and changing the observer on a guess is how a 1.5 pp row becomes a 1.4 pp row with a bug. Measured first.
- **Raise the budget.** ADR 0003, 0007 and 0020 refused three times and nothing here argues otherwise: the instrumentation fits, with a margin the series can now see.
- **Shed the fine detail by default to buy 0.2–0.4 pp.** It is the product's black box, it costs less than the noise, and ADR 0080 already sheds it when the hooks cost too much.
- **Leave the margin as a number without an owner.** That is where ADR 0020 left it, and where it stayed for eight days.

## Consequences

- `architecture.md` says where the CPU goes and that the margin is accepted with its guards; gh-570 closes. gh-592 carries the measurement inside Postgres and the profile of what runs outside the hooks.
- Five of seven rows are not resolved at nine rounds of twenty seconds; that is the honest reading of a machine that measures 0.1 pp effects with 0.2–0.6 pp of noise. Resolving them would take more rounds, which `bench-instruments` says how many before it spends the machine (ADR 0027).
- The first `instruments` run's report was lost to gh-590 and its table survives only in a log; the second is kept and is what the series holds. Two runs agreed on the one thing that mattered.
