# 0152 — A component's clock is handed in, never defaulted

Estado: aceptado · Fecha: 2026-09-23 · Alcance: público

## Context (gh-610)

ADR 0131 decided that every instant the agent produces comes from one clock, `AgentDeps.now`, and that no source
file under `packages/agent/src` reads the wall clock. A guard in `clock.test.ts` checked it by reading every
source file and looking for `Date.now(`.

Four components did not follow it, and none of them had to be wrong for that to happen. The interval
aggregator, the coarse register, the profile and the sender each took a clock as an **optional** parameter and
fell back to `Date.now` when none was given — `options.now ?? Date.now`, or `now = Date.now` in the signature.
`agent.ts` built all four and gave a clock to none. Every unit test drove a clock of its own and was green; the
one place that decided which clock production used was the one no test looked at. So in production the
interval, the profile window, the coarse register's seconds and the `Retry-After` deadline were on the wall
clock, and the capture's start and the requests it is compared against were on the agent's.

The guard did not see it for two reasons. A default argument is a **reference** to `Date.now`, not a call, and
the guard matched a call. And it read `src/` without recursing, so the three files under `src/instrument/` were
never opened — nothing there read the wall clock, but «anywhere in the source» was not what it checked.

It was not a `400` only by luck of the default. `Date.now()` returns an integer, and the batch's instants are
integers. The agent's clock is `performance.timeOrigin + performance.now()`, which is not, and the profile
wrote its window straight from its clock: wiring it without more would have turned every batch carrying a
profile into one the contract refuses, as happened to the capture's start in gh-608 (ADR 0145).

## Decision

**1. A component that keeps a clock is handed the agent's, and has no default.** `now` is a required property of
the options of `IntervalAggregator`, `CoarseRegister`, `ProfileAggregator` and `Sender`, and the options are a
required argument. `agent.ts` passes `this.now` to each. This is ADR 0126's rule applied where it was missing:
the parameter that joins two subsystems is not optional, because an argument nobody passes is a decision nobody
took, and a required one turns the forgotten wire into a compile error at the only call that matters.

`IntervalAggregator` takes an options object, `{ now, maxRoutes? }`, as the other three already did. A
positional `(maxRoutes, now)` would have needed the clock first or a placeholder for the size.

**2. The profile is rounded where it leaves, like the interval.** `close()` writes `start` as
`Math.floor(start)` and `durationMs` as `Math.max(1, Math.round(now − start))` — the expression the interval has
always used. What the aggregator keeps, and the comparison that decides whether a window is up, keep full
precision: rounding the stored start would close a window that began at `.9` of a millisecond almost a
millisecond early. It is ADR 0145's rule, at the wire and down, for the one window it had not reached because
its clock had never had decimals.

**3. The guard sees every way to read the wall clock, in every file, and is shown failing.** It flags `Date.now`
as a call or a reference, `new Date()` with no argument and `Date()`; it reads `src/` recursively and checks
that every directory under it was read; and a table of fixtures shows the detector flagging each form and
leaving alone `Date.parse(x)`, `new Date(x)`, `performance.now()` and a comment. A guard nobody has seen go red
is one nobody knows can.

**4. One origin, read in one file.** `performance.timeOrigin` appears in `agent.ts` and nowhere else. With no
default clock anywhere, the only way left for a component to grow an absolute clock of its own is to write
`performance.timeOrigin + performance.now()` again — the production value, so rule 3 lets it through, and a
second clock in every test that drives `AgentDeps.now`. And a type-level test fails to compile if any of the
four components can be built without a clock, so making one optional again is red in `make lint-node`.

## Alternatives

- **Keep the defaults and only pass the clock from `agent.ts`.** It fixes today and leaves the trap: the next
  component, or the next construction of one of these, forgets it the way these four did, and nothing but a
  reviewer notices.
- **Default to the production expression, from a shared module.** Right in production, and a second clock in
  every test that drives `AgentDeps.now` — each piece tested and the wiring not, which is how gh-498 shipped a
  prearmed reserve that did nothing (ADR 0126).
- **Round in the profile's clock, or when the window is stored.** The same alternative ADR 0145 rejected for
  the capture's start: it buys integers by giving back the resolution the one clock was chosen for.
- **Leave the sender alone, since its clock is a deadline and not an instant.** A deadline on the wall clock
  moves when the wall clock is stepped, and it was the one clock in the agent a test could not drive through
  `AgentDeps.now`. ADR 0145 counted three components on the wall clock for this reason; it was four.

## Consequences

- `IntervalAggregator`, `CoarseRegister` and `Sender` are exported, and a caller that built one without a clock
  no longer compiles. The changeset is a minor, because in 0.x a caret range takes a patch.
- The interval and the profile are dated on the same clock as the requests of a capture, so the three can be
  placed on one timeline however the wall clock has been stepped since the process started.
- A `Retry-After` given as a date is the other machine's wall clock compared with the agent's clock: the same
  trade a capture's `expiresAt` has made since ADR 0131.
- No batch changes shape. The interval was already rounded; the profile is now, and a test drives the real
  agent with a clock a day ahead of the wall clock and with a fraction to check both, and the wait.
- What is not covered by a behaviour test: the coarse register's clock, whose seconds do not leave the process
  yet. The compiler and the guard are what hold it.
