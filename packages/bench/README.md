# bench

Deterministic load generator and benchmark of the agent's overhead over the reference app. It is the executable form of invariant 3: the agent adds < 1 ms at p99, < 3 points of CPU and < 64 MiB of RSS. No dependencies.

## Use

```sh
make bench                                  # 3 rounds, 200 rps, 3 clean seconds of warm-up + 20 s of measurement
make bench BENCH_ARGS="--warmup 3 --warmup-max 30 --measure 12"
pnpm --filter @downtrace/bench run load --url http://127.0.0.1:4000 --rps 100 --duration 10 --seed 1
```

Those are the defaults of the harness, and they are smaller than the campaign's: a `make bench` on a laptop and a
kept report are not points on the same series unless they were given the same configuration. The campaign runs by
itself in the mirror; to force one, dispatch the mirror's `bench` workflow, which takes the rounds, the seconds
and the rate as inputs.

It needs `DATABASE_URL` and `REDIS_URL` **exported**: the harness demands them by name and reads no environment file, because two numbers measured from different start-ups cannot be subtracted (ADR 0023). If your Postgres is not on the usual port: `set -a; . packages/reference-app/.env; set +a` before `make bench`, or `make dev`. The reference app is started by the harness itself, in child processes with random ports.

### Options

`bench` (all optional; `make bench BENCH_ARGS="…"`):

| Flag | Default | What it is |
|---|---|---|
| `--rounds` | 3 | B/A rounds; each one starts the app in a fresh process |
| `--rps` | 200 | Fixed rate of the open loop |
| `--measure` | 20 | Seconds measured per round |
| `--warmup` | 3 | Consecutive clean seconds before measuring |
| `--warmup-max` | 30 | Cap on warm-up; if the app never gets clean, the bench ends |
| `--seed` | 42 | Seed of the traffic, the same for both variants |
| `--agent` | `packages/agent/src/register.ts` | Module loaded with `--import` in the variant with the agent (for example `fixtures/slow-agent.ts`) |
| `--source-commit` | — | Commit this tree was copied from, for a run outside the repository the code is written in |
| `--out` | `bench-report.json` | Path of the JSON report |

The app is started with `PORT=0 PROVIDER_PORT=0 ADMIN_ENABLED=1 REGRESSIONS=""` and inherits the rest of the environment (`DATABASE_URL`, `REDIS_URL`); the variant with the agent also gets `DOWNTRACE_TOKEN=bench` and a `DOWNTRACE_URL` pointing at a local sink that counts the batches.

`load` (`pnpm --filter @downtrace/bench run load …`): `--url` (`http://127.0.0.1:4000`), `--rps` (200), `--duration` (10), `--seed` (42), and `--json` for the full report instead of the table. It exits with 1 if any request failed.

## Where its number comes from, and when it is worth something

**It runs in the public mirror, on a GitHub-hosted `ubuntu-24.04-arm` runner, after a merge and never before
one** (ADR 0134). Every sync that touches the instrumentation, the protocol, this package, the reference app or
the lockfile measures a campaign of **9 rounds × 60 s at 200 rps** and keeps its report, one file per run, on the
mirror's `bench-reports` branch, which holds nothing else: an artifact expires, and a series that expires is not
a series. Two runs never overlap, because two benchmarks measuring at once measure each other. Nothing waits for
it — the mirror syncs after the merge, so no pull request can be gated on a measurement — and that half of what
ADR 0032 cost is deliberate and still unpaid.

Four cores with nothing else on them is the whole reason that runner was chosen. Launched by hand with
`make bench` it is the same measurement, and either way its number is only worth something if it is launched
well:

- **The machine to itself.** This is a comparative measurement: the baseline and the variant with the agent have
  to see the same machine. Anything else consuming CPU during those twenty minutes —another build, a heavy
  container, another tab compiling— is spread unevenly across the rounds and comes out looking like the agent.
  That is how it was found: measuring on a VM that ran the rest of CI, the seven worst connection waits of one
  run fell inside a job of the neighbouring runner (gh-200).
- **Against a Postgres that does not write in bursts.** The benchmark does not own the database —it measures against whatever `DATABASE_URL` it is given (ADR 0023)— and Postgres decides on its own when to push pages to disk: one real run saw it write for **26 seconds straight** inside a window of sixty. The repository's `docker-compose.yml` already spreads that writing out (`checkpoint_completion_target=0.9`, `checkpoint_timeout=15min`, `max_wal_size=2GB`); if you measure against another one, give it something equivalent. And the reset every round begins with ends in a `CHECKPOINT`, so the timed one starts counting again with the round: a campaign of nine rounds outlives those fifteen minutes, and until gh-584 the timed checkpoint fell inside round 8 of every run, in the baseline half, so every run of the series came out `inconclusive` with its three metrics `ok` (ADR 0136). The settings still matter: they are what keeps a checkpoint the reset could not prevent —one triggered by volume, or on a database whose user may not run `CHECKPOINT`— from bursting inside a window. In the mirror the database is that compose file itself and not a service container: a service container cannot be given arguments, and those arguments are exactly those settings, so they stay written in one place. And whichever you measure against, **the table says how many checkpoints there were in each round and how much they wrote**, and a pair whose halves saw very different things comes out `inconclusive`.
- **On the architecture it is deployed on.** ADR 0020 measured that the x86 figures never verified the budget:
  their noise was 3.998 ms against a budget of 1 ms. A comfortable, false green. The free runner is `aarch64`,
  which is what this is deployed on: that, and not merely getting off a shared machine, is why it measures there.
- **Reading the report, not only the verdict.** The per-round table says how much foreign CPU each one saw and the
  worst connection wait with its timestamp. If those two columns move between the two halves of a pair, that pair
  is not a comparison, and the verdict will say so.

And **its own tests split along the same line** (gh-412, ADR 0114). The ones that check what the bench decides —that an agent which does not deliver fails with its reason, that a baseline which never gets clean gives `inconclusive` with what the app said— run in CI with the rest of the integration. The ones that check a **measurement** —that the requested rate is reached within ±10 %, that a 200 ms delay is detected, that a 4 s cold start produces a round of between 6 and 10 seconds— are called `*.measure.test.ts` and are launched by `make bench-measure`, under the same conditions as the benchmark: a quiet machine and `DATABASE_URL`. In the monorepo's own CI they failed because of the neighbours, which is exactly what ADR 0032 took out of that pipeline.

And one limitation worth knowing in advance: the p99 of the reference application itself is **15.6 ms on that
runner** —it was around 24 ms on the shared VM and 28 ms on a laptop— and still moves by more than a millisecond
between rounds. The noise was max − min between rounds until gh-571, and a range grows with the number of rounds by
construction, so measuring more rounds reported **more** noise: nine rounds gave 2.5 ms where three gave 1.3, with
Δ barely moving. It is now the baseline's drift as a standard error with Student's t (ADR 0137): on the five kept
campaigns it is 0.27–0.98 ms at nine rounds, under the 1 ms line, and it shrinks with √n. What helps against a
large noise is now what the estimate says it is: **more rounds** shrink the drift term, **longer rounds** (more
samples) shrink the sampling term. A metric whose noise still exceeds its budget is not resolved, and is never
reported as verified. CPU, with 3 points of budget, is measurable.

## How it measures

- **Open loop**: requests go out at a fixed rate regardless of how long the server takes, and latency is measured from the *scheduled* instant of sending. A server falling behind appears as a queue; it does not hide behind a slower client.
- **The same traffic**: the sequence of endpoints and ids comes from a seed; both variants receive exactly the same requests.
- **Alternating rounds** B/A/B/A/B/A, each in a fresh process, so that the machine's noise is spread across variants.
- **A warm-up that ends clean**: each round takes load one second per slice until it strings together `--warmup` seconds with no failed request (3 by default), capped by `--warmup-max` (30). A cold database is waited for, not measured. If the app never gets clean, the bench ends: `inconclusive` if it was the baseline round, `fail` if it was the agent's, and the reason includes the first error lines the app itself wrote to stderr. The reference app simulates that cold start with `STARTUP_FAILURE_MS`.
- **Latency**: p99 over **all the pooled samples** of each variant (5 × 2400 → ~120 values decide the p99). The **noise** is the larger of two estimates (ADR 0010): the halves one (shuffle the baseline with a seed, split in two, |p99(A) − p99(B)|, maximum of 20 repetitions), which measures sampling variability, and the **drift between rounds** of the baseline (`t(n−1) · sd(its p99s) · √(2/n)`, ADR 0137), which measures the machine moving between identical rounds as the error it puts on a difference of two medians — a standard error and not a range, so more rounds shrink it instead of growing it (gh-571); the report says which one ruled. On top of that, a latency `fail` demands **corroboration**: most of the agent's rounds have to be over the budget by more than the noise on their own (ADR 0111), so that an isolated stall does not bring down the verdict. **CPU and RSS**: median per round, and the same drift estimate as the noise. With a single round nothing can estimate its own drift, and the bench refuses to measure.
- **What it was measured against**: every round reads the CPU of **the whole machine** during its window and subtracts that of everything the benchmark runs —the application being measured and its own process, which carries the load generator and the sink—; what is left is the **foreign CPU**, in the same unit as `cpuPct` (100 = one core). Rounds alternate so that each pair sees the same machine, so what invalidates a comparison is not that there were neighbours —on a shared machine there never are none— but that there were **different neighbours in each half of the pair**: above twenty points of difference, that metric comes out `inconclusive` naming the round (ADR 0031). It never turns a `fail` into an `inconclusive`, and where the host CPU cannot be read it reports «?» without degrading anything: not knowing is not measuring quiet.
- **Where the measured CPU goes**: the agent times one hook in sixty-four and sends the estimate in every batch (`agent.resources.hookMsPerRequest`, ADR 0080); the sink reads it, and the report puts its mean beside the measured Δ CPU in the same unit — a percentage point of one core is 10 ms of CPU per second, so `Δpp × 10 / rps` is milliseconds per request — and says what share of the cost is inside the hooks. What is not is what runs outside them: transport, serialisation, timers, the pressure on the collector. Both numbers are estimates and the line says so (gh-570).
- **Verdict** per metric: `ok` if Δ ≤ budget; `fail` if **Δ − budget > noise**; `inconclusive` if Δ > budget but the excess does not exceed the noise — the machine cannot resolve the budget. What has to exceed the noise is the **margin**, not Δ (ADR 0030): comparing Δ with the noise answers "does the overhead exist?", which is not what a budget asks, and for CPU it was always satisfied. The table prints the margin in its own column, because it is the number the result depends on. An `ok` whose noise exceeds its budget is **not resolved**: the metric did not cross, but the machine could not tell a Δ under the line from one just over it, so the row says `ok, unresolved` and the run is `inconclusive`, never `pass` (gh-587, ADR 0138). A run is `pass` only when every metric is `ok` **and** resolved; `inconclusive` means this machine could not resolve a budget, on whichever side of the line Δ fell. `fail` → exit 1; anything else → exit 0 (`inconclusive` warns). **Request errors** rule: in the agent's rounds → `fail`; in the baseline only → `inconclusive` (never a `pass` on broken data). The report breaks the errors down by code (`502×3, timeout×86`).
- **Report**: `bench-report.json` and a Markdown table on stdout, and under Actions the same table goes to `$GITHUB_STEP_SUMMARY`, so a run shows its own result without anybody downloading anything. **It says what it measured and on what**: the cores, the memory and the processor of the machine —which a runner pool decides and not you—, the module, its version, the commit, whether that tree had uncommitted changes and whether the code came from the working tree or from an installed package, which are not interchangeable evidence; what it could not determine is an explicit `null`, because an absent field reads as «does not apply» and this is «we could not tell». A tree that is a copy of another repository —the mirror is— carries the commit it was copied from as well, since its own resolves nowhere upstream.

### What each observer costs

`make bench-instruments` measures the cost of each observer **separately**, running the benchmark once per configuration: with nothing, and then adding runtime, Postgres, outgoing HTTP and Redis one at a time; then, with every observer on, the two halves of the black box that the instrumentation can shed on its own (ADR 0080) — the **fine detail** and the **profile** — each held shut with `DOWNTRACE_SHED` on one side of the pair and kept on the other (gh-570). Seven comparisons; each row is what that one thing costs. It writes `instruments-report.json` beside the Markdown, and the mirror's `bench` workflow runs it when dispatched with `mode: instruments`, keeping the report on `bench-reports` under an `instruments-` name; 20 seconds per round is plenty there, and 60 takes over two hours.

The budget of invariant 3 is one number for the whole agent, so when it starts to bite the only useful question will be which one to pay for and which not, and that is not answered with a total.

Each step compares **two configurations of the agent head to head**, not each one against nothing: measuring separately and subtracting differences two independent measurements and doubles the uncertainty. The comparison is **paired round by round**, because the rounds alternate in time and each pair saw the same machine. Whether a row is a measurement or the machine having a bad moment is decided by a **permutation test** over the signs of those differences —under the hypothesis that the observer costs nothing, which of the two sides came out higher is a coin toss—: exact up to 20 rounds by enumerating the 2ⁿ reassignments, sampled with the seed above that. It assumes no normality, which the differences of a benchmark do not have. The level is 0.05 **split across the comparisons of the run** (Bonferroni, ADR 0027), because with five comparisons at once, one of them coming out resolved by chance stops being improbable. With five steps the gate is 0.01, and since the smallest p that n differences can reach is 2/2ⁿ, **at least eight rounds** are needed for anything to be resolvable: that is why that is the default, and why the tool aborts before spending the machine if you ask for fewer. Where the table says something does not resolve, the machine has not measured that observer and the number means nothing. The report also prints **the differences per round**, so that the next doubt is resolved by re-reading and not by measuring.

**No published figure of this breakdown is citable.** The runs before ADR 0027 used a gate that did not hold up its own comparisons, and redoing the arithmetic over them resolves no row at all (gh-187). What is measured, on a controlled bench and not here, is that the agent with no observers at all costs about 2.4 µs of CPU per request —1.6 % of the budget at 200 rps— (gh-171). The per-observer breakdown gets figures again when it is run under the new gate on a quiet machine.

It does not run in CI: it is a full run of the benchmark per instrument, and it is a tool for deciding, not a guardrail.

The budget lives in `src/budget.ts`. `fixtures/slow-agent.ts` is a fake agent that delays one request in every 50 by 200 ms (a tail regression, the kind the p99 watches): it proves that the benchmark knows how to fail on noisy machines too.
