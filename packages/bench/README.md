# bench

Deterministic load generator and benchmark of the agent's overhead over the reference app. It is the executable form of invariant 3: the agent adds < 1 ms at p99, < 3 points of CPU and < 64 MiB of RSS. No dependencies.

## Use

```sh
make bench                                  # 3 rounds, 200 rps, 3 clean seconds of warm-up + 20 s of measurement
make bench BENCH_ARGS="--warmup 3 --warmup-max 30 --measure 12"
make bench-coexistence                      # what @sentry/node costs beside the agent (ESC-16): one head-to-head campaign
make bench-profile                          # what runs outside the hooks: a profiled pair, read by function (gh-592)
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

`make bench-instruments` measures the cost of each observer **separately**, running the benchmark once per configuration: with nothing, and then adding runtime; then the Postgres observer **part by part** — the wrapper, the context of the query, the text of the query — then outgoing HTTP and Redis one at a time; and, with every observer on, the two halves of the black box that the instrumentation can shed on its own (ADR 0080) — the **fine detail** and the **profile** — each held shut with `DOWNTRACE_SHED` on one side of the pair and kept on the other (gh-570). Nine comparisons; each row is what that one thing costs, and the three rows of the Postgres observer add up to what it costs whole (gh-592). It writes `instruments-report.json` beside the Markdown, and the mirror's `bench` workflow runs it when dispatched with `mode: instruments`, keeping the report on `bench-reports` under an `instruments-` name; 20 seconds per round is plenty there, and 60 takes over two hours.

The Postgres observer is weighed part by part because it is the row the machine resolved in the reading that led here (ADR 0139): 1.5–1.6 of the ~2.7 points, and the question the total leaves open is which part. The switch is `DOWNTRACE_PG_DEPTH`, read by the agent like `DOWNTRACE_SHED` — a benchmark's switch, not an operator's, and an unknown value means the observer as it is rather than a refusal to start. Its levels, shallow to deep:

- `wrapper`: the patch is in place and the wrapper runs, and records nothing — no timing, no attribution, no pool wrap, because those exist to charge the work to a request.
- `context`: the calls and the waits are attributed to the request — the timing, the callback and promise plumbing, the wait for a connection bound with `AsyncResource.bind` — and the query text is never looked at.
- `full` (the default, and the absence of the variable): the observer as it is, which also builds the fingerprint of the query text — the normalisation and the hash, and the operation it keys.

Each level is what it says and nothing else: the application's query does exactly what it did at every depth, and an agent that does not set the variable runs the full observer, so the switch is additive — it moves no budget and touches none of the arithmetic ADR 0067 checks, which is about the registers.

The budget of invariant 3 is one number for the whole agent, so when it starts to bite the only useful question will be which one to pay for and which not, and that is not answered with a total.

Each step compares **two configurations of the agent head to head**, not each one against nothing: measuring separately and subtracting differences two independent measurements and doubles the uncertainty. The comparison is **paired round by round**, because the rounds alternate in time and each pair saw the same machine. Whether a row is a measurement or the machine having a bad moment is decided by a **permutation test** over the signs of those differences —under the hypothesis that the observer costs nothing, which of the two sides came out higher is a coin toss—: exact up to 20 rounds by enumerating the 2ⁿ reassignments, sampled with the seed above that. It assumes no normality, which the differences of a benchmark do not have. The level is 0.05 **split across the comparisons of the run** (Bonferroni, ADR 0027), because with several comparisons at once, one of them coming out resolved by chance stops being improbable. The gate is 0.05 divided by the number of comparisons the run makes, and since the smallest p that n differences can reach is 2/2ⁿ, the fewest rounds at which any row could clear it are what the tool takes as its default — nine comparisons need **nine rounds** — and it aborts before spending the machine if you ask for fewer. Where the table says something does not resolve, the machine has not measured that observer and the number means nothing. The report also prints **the differences per round**, so that the next doubt is resolved by re-reading and not by measuring.

**No published figure of this breakdown is citable.** The runs before ADR 0027 used a gate that did not hold up its own comparisons, and redoing the arithmetic over them resolves no row at all (gh-187). What is measured, on a controlled bench and not here, is that the agent with no observers at all costs about 2.4 µs of CPU per request —1.6 % of the budget at 200 rps— (gh-171). The per-observer breakdown gets figures again when it is run under the new gate on a quiet machine.

It does not run in CI: it is a full run of the benchmark per instrument, and it is a tool for deciding, not a guardrail.

The budget lives in `src/budget.ts`. `fixtures/slow-agent.ts` is a fake agent that delays one request in every 50 by 200 ms (a tail regression, the kind the p99 watches): it proves that the benchmark knows how to fail on noisy machines too.

### What it costs to live beside the tracker

`make bench-coexistence` measures what it costs the reference app to have `@downtrace/agent` and `@sentry/node`
loaded at the same time (ESC-16). It is one head-to-head campaign, same app, same seeded load, changing
**one thing**:

- base: `node --import @downtrace/agent/register src/main.ts` — the whole agent.
- contra: `node --import @downtrace/agent/register --import ./src/sentry.ts src/main.ts` — the same agent with
  the tracker loaded beside it, the agent first and the tracker after, the order that loses least (ADR 0147).

The tracker's `SENTRY_DSN` points at a local sink of the bench (`src/tracker-sink.ts`, beside the sink of the
batches): the tracker's own transport, its own envelopes — and nothing leaves the machine, because the sink
binds `127.0.0.1` on a port that only the round knows. The report says how many envelopes, transactions and
events the tracker actually shipped, which is what proves it was live in the comparison. The tracker is the
reference app's own entry point (`packages/reference-app/src/sentry.ts`), and `@sentry/node` is a development
dependency of `@downtrace/reference-app` alone: this package reaches it through the workspace and adds nothing
of its own.

The reading, with the rules this package already has (ADR 0027 for significance, ADR 0137 for noise, ADR 0111
for corroboration by rounds):

1. **Δ p99, Δ CPU and Δ RSS between the two configurations** — what it costs to have the tracker beside.
   Reported apart, because it is **not this package's budget**: the budget of invariant 3 is the
   instrumentation's, and it is what the `bench` campaign measures, the agent against no agent. Declaring a
   `pass` or a `fail` of it against this pair would be a verdict the measurement does not make; what comes out
   is a reported number.
2. **The agent's own estimate (`agent.resources.hookMsPerRequest`, ADR 0080), in the two configurations.** It
   is what the budget measures, sampled inside `guard`, so it cannot contain the tracker's work by
   construction. That it does not move is the half of the clause that says the tracker's cost is not attributed
   to the agent.

Each row is decided by a permutation test over the paired per-round differences — no assumption about their
shape — at a level shared among the run's four comparisons, the three deltas and the hook estimate
(Bonferroni, ADR 0027). The default is the fewest rounds at which any of the rows could clear that gate, and
the tool says so before spending the machine. It writes `coexistence-report.json` beside the Markdown, and the
mirror's `bench` workflow runs it when dispatched with `mode: coexistence`, keeping the report on
`bench-reports` under a `coexistence` name.

It does not run in CI: it is a full run of the benchmark, and it is a tool for reading, not a gate.

### What runs outside the hooks

The campaign's report has said since gh-570 what share of the measured cost is **inside** the hooks — the
agent's own estimate of them, sampled inside `guard` (ADR 0080) — and what runs **outside** them: «transport,
serialisation, timers, the pressure the agent puts on the collector». This campaign is the reading of that
other half, by function (gh-592): a CPU profile of the rounds, read where the CPU sat.

`make bench-profile` runs the benchmark's pair under its load with `--cpu-prof`, and **both halves are
profiled**, each in its own directory: the reading is the difference between the two sides, and a profiled
side against an unprofiled one is two measurements that cannot be subtracted. `--rounds` is how many pairs
that reading is summed over — one pair is a reading, and the profile of a pair is not a point on the series;
more pairs are the same reading with more samples, which is why the mirror's dispatch for it is one round at
twenty seconds, and why the tool says the window a profile covers — warm-up and measured window, not only the
measured seconds — instead of letting a number without its window pass for one with it.

What it says, in `profile-report.json` and the Markdown beside it:

1. **The round's CPU by source, in the two configurations, and the difference** — the agent's files, the
   application's, the driver's (`pg` and `pg-pool`), Node's internals, and the runtime, where V8 is and the
   collector shows up. The agent's row is the agent; the difference of the runtime's row is the pressure its
   allocations put on the collector; the difference of the application's and the driver's is what its work
   moved in them. The thread's idle is wall time, not CPU, and a machine at a tenth of a core is idle nine
   tenths of the time: it is reported as its own number and left out of the totals, so the window and the
   CPU are told apart. Where the halves profiled different numbers of rounds, the windows are not the same
   length and the table says so instead of subtracting.
2. **The top functions of the side that carries the agent, by self time** — where the CPU sat, with the
   source each came from. Self time, not cumulative: a frame that spends its time in its callees is not a
   function that is expensive.
3. **The inside/outside line, in the same unit**: the hook estimate in points of a core at the run's rate,
   beside the pairs' measured CPU, so the tables are read against the number they exist to explain. One pair
   is said as one pair.

It is **not a verdict** of the budget, and nothing in it is a `pass` or a `fail`: the budget is what the
`bench` campaign measures, the agent against no agent, over rounds. The profiled processes pay the
profiler's own cost, and both halves pay it, which keeps the difference honest and the numbers out of the
campaign's arithmetic. It does not run in CI: it is a full run of the benchmark, and it is a tool for
reading, not a gate.

The mirror's `bench` workflow runs it when dispatched with `mode: profile`, keeping the report on
`bench-reports` under a `profile` name **with its raw profiles beside it** — one file per profiled round —
because a doubt about a row of the summary is read out of the profile, not measured again. What the reading
decides — whether there is margin to recover, and from which part, or that it does not pay — is written from
the kept report, when the mirror runs it: that writing is a step the campaign exists to make possible, and it
is the successor ticket's, not this package's.

## The canary

The canary is not a benchmark: it asks a **deployed** cloud whether it sees what a regression of the reference app
should cause, with the detector's real windows and its real rule — the part no test in CI reaches.
`canary/docker-compose.yaml` is the whole of it: a reference app reporting to that cloud, steady traffic through it
(`load`, three requests a second), and the canary's door (`src/canary-cli.ts`). None of them has a public port, and only the canary's door joins
the network of whatever schedules it (`CANARY_SHARED_NETWORK`, `coolify` by default; locally, any network that
exists): `/__admin` switches regressions with no credential, so the reference app stays on the stack's own network,
and the scheduler calls `POST /cycle` on `http://downtrace-canary:8080`, one regression a night.

A cycle (`src/canary.ts`):

1. checks that the reference app answers with every regression off, that the project's batches are arriving (the
   last one within two minutes) and that no finding like the expected one is already open — any of those, and the
   night is `unmeasurable`; a regression found on is switched off for the next night;
2. switches the regression on, with whatever it needs to show at all (`aggressive_retries` only retries what fails,
   so its night also slows the provider past its timeout), and reads the project's findings and its freshness every
   minute until the expected one opens;
3. reads the pattern its report recognises;
4. switches it off, giving back the parameters it found, and reads the finding's verification since that instant
   until it says `recovery-observed`.

It answers once the cycle is over: `pass`, `fail` (the cloud answered, and not as expected) or `unmeasurable` (the
app or the cloud did not answer, or the data was not arriving, before the night or at any moment of a wait that
ended without the answer: no data is not no errors), with one sentence saying why, the instants, the minutes it took
to detect and to recover, the finding and its report, and what opened instead. The regression is switched off on
every path, three times if it has to be; when even that fails, the outcome is `fail` and the reason says it first. A
failure of the canary's own is an answer too, `unmeasurable`. One cycle at a time: a second request while one runs
is a 409 naming it.

A finding the cloud had seen once but not yet confirmed when the night began, and confirms during it, counts as
new; with every regression off before the night that is a degradation of its own, and the night says which finding
it was. And a project too young for the detector's history is not told apart from a detector that misses: give the
stack its half day before reading its first night.

What each regression should cause is `src/canary-expectations.ts`, in the cloud's own names: the trigger that may
open the finding, where it is (a route, or a dependency of the project as a whole) and the patterns its report may
recognise. `n_plus_one` is the shape the end-to-end walk of a real regression already proves; the other four are
read off the detector, and the canary's nights confirm them or say which finding came instead.

It is slow because the detector is: a five-minute window against a two-hour reference and twelve hours of history,
two sightings to open a finding, two clean checks to observe a recovery. The stack has to run for half a day before
its first night means anything, and a cycle lasts up to the two limits together, an hour and three quarters by
default.

The image is built from the repository's root with its lockfile, and the instrumentation it loads is the
workspace's: the reference app of this tree calls what this tree's instrumentation exports, which a published
version may not have yet. The published package is watched where its users run it.

| Variable | Default | What it is |
|---|---|---|
| `CANARY_APP_URL` | — | Base URL of the reference app |
| `CANARY_CLOUD_URL` | — | Base URL of the cloud it reports to |
| `CANARY_TOKEN` | — | An access credential of the project, level `read` |
| `CANARY_PROJECT` | — | The project's slug |
| `CANARY_PORT` | 8080 | Where the door listens |
| `CANARY_POLL_SECONDS` | 60 | How often it reads the findings and the verification |
| `CANARY_DETECT_WITHIN_MINUTES` | 45 | How long the expected finding has to open |
| `CANARY_RECOVER_WITHIN_MINUTES` | 60 | How long the recovery has to be observed |

The compose file adds the reference app's own: `DOWNTRACE_URL`, `DOWNTRACE_TOKEN` (the project's ingest token) and
`POSTGRES_PASSWORD`. What is missing stops the start, and so does a number that is not a positive integer.
