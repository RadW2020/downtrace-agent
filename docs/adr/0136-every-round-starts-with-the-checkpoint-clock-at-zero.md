# 0136 — Every round starts with the checkpoint clock at zero

Estado: aceptado · Fecha: 2026-09-15 · Alcance: público

## Context

ADR 0134 put the benchmark on a machine of its own and gave it a default campaign of 9 rounds × 60 s, the configuration every figure of ADRs 0020 and 0021 comes from. Against the repository's Postgres (`docker-compose.yml`), whose `checkpoint_timeout` is fifteen minutes since gh-194 spread its checkpoints out, that campaign lasts about eighteen.

The four reports on the mirror's `bench-reports` branch (2026-09-14 18:23 and 21:43, 2026-09-15 06:53 and 07:12) all say the same thing. Round 8's baseline half starts between t+14.6 and t+15.0 minutes and sees one checkpoint writing for 22.5 s; the agent half of the same pair sees none; no other round sees any. The pair rule of gh-194 does what it was written to do and calls the run `inconclusive` — «rounds 8 saw the database write checkpoints in one half and not the other, so the pair is not a comparison» — while the three metrics of every one of the four runs are `ok`. The series has four points and no valid one, and the checkpoint always falls on the baseline: seven double rounds of ~65 s per half put round 8 at the fourteenth minute every time.

ADR 0021 made every round start on the same database, because rounds that start unequal are not comparable. The checkpoint clock was not part of «the same»: it kept running from one round into the next, and the fifteenth minute belonged to whichever round was measuring then.

## Decision

**The database reset that begins every round ends with a `CHECKPOINT`.** Postgres schedules its timed checkpoint `checkpoint_timeout` after the last checkpoint, whoever asked for it, so the clock restarts with the round; a round shorter than that interval cannot meet a timed checkpoint, whatever the campaign's length. The checkpoint also flushes what the reset itself just wrote, before the warm-up instead of inside the window.

- **The app does it, not the bench** (ADR 0021): `POST /__admin/db/reset` runs the checkpoint as its own statement after the truncate-and-restock transaction has committed, so a checkpoint that fails cannot undo the reset.
- **A checkpoint the database refuses fails the reset.** `CHECKPOINT` needs a superuser or, from Postgres 15, the `pg_checkpoint` role. The compose file, `make dev` and the three CI jobs connect as the image's `POSTGRES_USER`, which is one. Anywhere else, the error names the privilege and the reason, the route answers 500, and the bench aborts the round as it does for any reset failure — never a 204 with the clock still running, which would be gh-584 again with nothing saying so.
- **Nothing else moves.** The compose settings stay: spreading is still what keeps a checkpoint the reset cannot prevent — one triggered by volume, or on a database whose user may not run `CHECKPOINT` — from bursting inside a window. The per-round counters and the pair rule of gh-194 stay, and the forced checkpoint happens before the round's counters are read, so it does not appear in the round.

## Alternatives

- **Raise `checkpoint_timeout` past the campaign.** One line in the compose file, and the fix would hold only for campaigns shorter than the new number, only against this Postgres, and only until somebody asked for twelve rounds. Whoever measures against another database is told to «give it something equivalent», and this would be one more thing to replicate.
- **Make the bench force the checkpoint through its own connection.** `packages/bench` has no external dependencies and the app is what knows the database (ADR 0021); adding `pg` to the harness for one statement buys nothing over one more line in the endpoint the harness already calls.
- **Tolerate a refused checkpoint and go on.** The round would be measured and the pair rule would still catch a storm, so it is tempting. But a reset that does half its job and answers 204 is exactly the silent non-comparability ADR 0021 forbids, and the user who cannot run `CHECKPOINT` is told what to grant instead of discovering it eight rounds later.
- **Leave it and read the series around round 8.** Four out of four runs thrown away by construction is not a series, and a rule that says «ignore the verdict, it is always that round» is a rule nobody will read in three months.

## Consequences

- The next campaign of the mirror is what confirms this: its round 8 should see no checkpoint and its verdict should be what its metrics say. Until that run exists, the four kept reports stay what they are, `inconclusive`, and count as verification of nothing (ADR 0030).
- gh-571 and gh-570 need campaigns of eight rounds or more and could not have them; they can now.
- The reference app's README says what the route does; the bench README says why the compose settings still matter; `architecture.md` says it where it describes the route and the round.
- What nothing checks: that a round is shorter than `checkpoint_timeout`. A five-minute round against a database whose interval is one minute would meet a timed checkpoint again, and the pair rule would say so, as it did here.
