# 0137 — The noise between rounds is a standard error, not a range

Estado: aceptado · Fecha: 2026-09-15 · Supera del ADR 0007 el ruido máx−mín de CPU y RSS y su receta de «más muestras, no más rondas», y del ADR 0010 el componente máx−mín del ruido de latencia; concreta la receta del ADR 0003 · Alcance: público

## Context

The verdict compares the excess over the budget with a noise estimate (ADR 0030). Since ADR 0003 the part of that estimate that measures the machine moving between rounds has been a **range**: max − min of the baseline rounds for CPU and RSS (ADR 0007, «son estables»), and the same max − min of the baseline's per-round p99s as one of the two components of the latency noise (ADR 0010, the *round-spread*). A range never shrinks when a round is added and grows with the count of rounds by construction. So the answer those ADRs gave to a noise that does not fit the budget — more samples — made the reported noise larger, and ADR 0007 rejected «more rounds» for the right symptom and the wrong reason: with a range they did not help.

Measured on the five campaigns kept on the mirror's `bench-reports` branch (same runner, nine rounds each; the first k baseline rounds of each; «drift» is the estimator this ADR adopts):

| CPU, pp | k=3 range → drift | k=5 | k=7 | k=9 |
|---|---:|---:|---:|---:|
| 09-14 18:23 | 1.88 → 3.41 | 2.50 → 1.79 | 2.50 → 1.16 | **4.33** → 1.38 |
| 09-14 21:43 | 0.19 → 0.33 | 0.49 → 0.36 | 0.49 → 0.23 | 0.49 → 0.17 |
| 09-15 06:53 | 0.57 → 1.05 | 0.65 → 0.46 | 1.73 → 0.83 | 1.73 → 0.60 |
| 09-15 07:12 | 0.58 → 1.07 | 1.62 → 1.09 | 1.62 → 0.67 | 1.62 → 0.53 |
| 09-15 13:00 | 0.67 → 1.30 | 0.82 → 0.59 | 1.00 → 0.48 | 1.30 → 0.43 |

| p99 per round, ms | k=3 range → drift | k=5 | k=7 | k=9 |
|---|---:|---:|---:|---:|
| 09-14 18:23 | 1.52 → 2.87 | 1.92 → 1.44 | 1.92 → 0.98 | 2.53 → 0.98 |
| 09-14 21:43 | 0.12 → 0.23 | 0.31 → 0.22 | 0.78 → 0.36 | 0.80 → 0.32 |
| 09-15 06:53 | 0.34 → 0.65 | 0.34 → 0.25 | 0.76 → 0.36 | 0.76 → 0.27 |
| 09-15 07:12 | 0.37 → 0.65 | 1.13 → 0.79 | 1.13 → 0.52 | 1.35 → 0.42 |
| 09-15 13:00 | 1.06 → 1.91 | 1.06 → 0.70 | 1.06 → 0.44 | 1.06 → 0.33 |

The range grew from three rounds to nine in every campaign and for every metric, or at best stayed. The drift fell from three to nine in fifteen series out of fifteen. At nine rounds the CPU noise is 0.17–1.38 pp where the range said 0.49–4.33, and the p99 drift is 0.27–0.98 ms — under the 1 ms line of invariant 3 in five campaigns out of five, where the range was under it in one. RSS behaves the same way. At three rounds the drift is about 1.8 × the range: three rounds resolve little, and now the estimate says so.

## Decision

**The noise the machine puts between rounds is estimated as a standard error with Student's t, from the baseline rounds:**

```
drift = t(n−1) · sd(baseline rounds) · √(2/n)
```

`sd` is the sample standard deviation of the n baseline rounds — the machine measuring the same thing n times. `√(2/n)` is what that drift does to a difference of two medians each taken over n rounds. `t(n−1)` is the two-sided 97.5 % quantile of Student's t: 4.30 at three rounds, 2.31 at nine, the last tabulated value (2.042) beyond thirty degrees of freedom, so that the factor is never less conservative than the table and has no jump in it.

- **For CPU and RSS** the drift is the whole noise, in place of max − min.
- **For latency** the noise is `max(split-half, drift)`, in place of `max(split-half, max − min)`; `noiseSource` says `round-drift` or `split-half`. The corroboration rule (ADR 0010, 0111) and the pooled p99 do not change.
- **Δ does not change**: median(agent) − median(baseline) for CPU and RSS, the pooled-p99 difference for latency. A median is what the estimate of the effect is robust with; the standard error is what its uncertainty is honest with. They need not be the same statistic.
- **Only the baseline goes in.** An agent round that goes wild is what corroboration exists for (ADR 0111): the two CI runs replayed in `latency-rule.test.ts` keep their verdicts, one `fail` with both rounds corroborating and one `inconclusive` with a single stalled round.
- **A single round cannot estimate its own drift**: the estimate is infinite below two rounds and `bench-cli` refuses `--rounds 1` before spending the machine.
- **The three statuses keep their meaning** (ADR 0030): `ok` if Δ ≤ budget, `fail` if the excess over the budget exceeds the noise, `inconclusive` otherwise, and `inconclusive` never counts as approved (ADR 0134).

The documented cure for a large noise becomes what the estimate makes true: more rounds shrink the drift term by √n, longer rounds — more samples — shrink the sampling term.

## Alternatives

- **Keep the range and prescribe longer rounds only.** Longer rounds do nothing for a range of per-round values; the 1 ms line would stay unresolved at any campaign length, which is where a month of measuring left it.
- **The paired differences agent − baseline, round by round, as `t · sd(d) / √n`.** Statistically the most direct uncertainty of Δ, and what `instruments-cli` already describes its spread with (ADR 0027). Rejected here because it lets an agent round that goes wild inflate the noise: replayed on the run of gh-394 it turns a regression measured in every round into `inconclusive`, which is exactly the decision ADR 0111 took the trouble to reverse. The instruments tool keeps it: there the question is different, and a permutation test decides.
- **A robust scale — the median absolute deviation — instead of the standard deviation.** It hides a drifted round, and a drifted baseline round is precisely the machine moving, which is what this estimate is for (`verdict.test.ts`: «a baseline round that drifted is counted as noise, not as precision»).
- **Two standard errors, without the t factor.** Three rounds would claim the precision of thirty. The t quantile costs a table of thirty numbers and no dependency.
- **A bootstrap or a formal test.** ADR 0007 refused them for legibility and nothing has changed: a standard error is one line in a table and one sentence in a README.

## Consequences

- The bench README's paragraphs on the limitation and on how it measures, `architecture.md`, and the Estado lines of ADR 0003, 0007 and 0010 say so. Seven existing tests were re-pinned to the new values, each with the old one beside it in a comment; two exact-tie tests could not be built from rounds once the noise carries a √2 and a t quantile, so the tie is pinned where the sampling noise is injected and the CPU boundary is pinned from both sides.
- Three rounds now report *more* noise than the range did, and nine report less: a campaign that wants to resolve the 1 ms line is a long one, and the bench says so instead of flattering a short one.
- What this does not resolve, and gets its own ticket: an `ok` whose noise exceeds its budget. The status means «Δ did not cross», and with noise larger than the budget the measurement cannot tell a Δ under the line from one just over it. Whether such an `ok` should say so is a question about what the report claims, not about the estimator.
- Nothing checks that the t table is right beyond reading it. Its thirty values are the ones in every statistics textbook, and the test pins six of them and their monotony.
