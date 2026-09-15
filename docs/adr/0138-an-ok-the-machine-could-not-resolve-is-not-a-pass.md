# 0138 — An `ok` the machine could not resolve is not a `pass`

Estado: aceptado · Fecha: 2026-09-15 · Supera del ADR 0030 la lectura de que un `ok` no necesita resolverse, solo para el veredicto de la tirada; hace comprobable la frase del ADR 0134 «never reported as verified» · Alcance: público

## Context

A metric is `ok` when Δ ≤ budget, and ADR 0030 decided — rightly, for the metric — that «not being over does not need resolving: the question only arises once the budget is crossed». The run is `pass` when every metric is `ok`. But a noise larger than the budget means the machine could not see the line: a Δ of 0.9 ms and one of 1.1 ms are the same measurement to it, and an `ok` under those conditions verifies nothing. The report painted it ✅ like any other and wrote `pass` on top.

In the five campaigns kept before ADR 0137, p99 came out `ok` in all five with noises of 2.527, 0.795, 0.758, 1.35 and 1.067 ms against a budget of 1 ms: three of those five greens were unresolved. The bench README has called this «a comfortable, false green» since gh-530, and ADR 0134 promised that «a metric the machine cannot resolve is never reported as verified» — a sentence, and until now nothing in the report to hold it to.

ADR 0137 shrank the noise and made the line resolvable where it was not; it did not change what an `ok` claims. This does.

## Decision

**Every metric says whether the machine resolved it, and a run is `pass` only when every metric is `ok` and resolved.**

- `resolved` is a field of every metric's verdict. An `ok` is resolved when its noise fits inside its budget. A `fail` is resolved by construction: its excess beat the noise. An `inconclusive` is not.
- The three statuses keep their meaning (ADR 0030): `ok` still says «Δ did not cross». What changes is what the run says about it: an unresolved `ok` makes the run `inconclusive`, with a reason that names the metric, its Δ, its noise and its budget and says that the machine cannot tell a Δ under the line from one just over it. `inconclusive` already meant «this machine could not resolve a budget»; this is the same meaning on the other side of the line.
- The table paints an unresolved `ok` as a warning — `⚠️ ok, unresolved (noise N > budget B)` — and never as a green check. The JSON carries the field.
- `fail` is untouched, and `inconclusive` never counts as approved (ADR 0030, 0134).

## Alternatives

- **A fourth status.** It would say the same thing as `ok` plus a flag and cost every reader of the JSON a new case. The status answers «did it cross?»; the flag answers «could the machine see the line?». They are two questions and stay two fields.
- **Leave `pass` alone and mark the row only.** A `pass` is what the mirror's series records and what the README calls verified; a row nobody reads under a green `pass` is the same false green with a footnote. ADR 0134 promised «never reported as verified», and the verdict is the report.
- **Require resolution for `fail` too.** A `fail` already requires its excess to beat the noise (ADR 0030); that is what resolving it means.
- **Do nothing until the noise is small enough everywhere.** ADR 0137 brought the p99 drift under 1 ms at nine rounds on the five kept campaigns, so the line is now resolvable where it was not; where it still is not, the report must say so rather than pass.

## Consequences

- Campaigns whose p99 noise stays above 1 ms come out `inconclusive` instead of `pass`. That is the truth ADR 0134 already stated in prose, and the first thing the next campaign tells is whether the line is resolved after ADR 0137.
- The Estado line of ADR 0030 says which reading stays and which this supersedes. The bench README's «Verdict» bullet says what each status and the verdict claim, and `architecture.md` says it where it describes the verdict.
- A test replays the campaign of 2026-09-15 13:00 from its own figures — Δ 0.888 ms under a budget of 1 with 1.067 ms of noise — and pins it as `ok`, unresolved, not `pass`. The motivating case is what the rule is checked against.
- What is not touched: the estimator (ADR 0137), the budgets, the corroboration rule, the mirror workflow.
