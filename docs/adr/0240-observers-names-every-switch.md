# 0240 — `observers` names every switch

Estado: aceptado · Fecha: 2026-10-30 · Amplía el ADR 0093 y el protocolo 0.11.0 · Alcance: público

## Context

Since 0.7.0 a batch says, by switch, what the instrumentation is watching: `on`, `off`, or `unavailable` — asked for
and could not attach (ADR 0093). The schema named the four switches there were then, `pg`, `http`, `redis` and
`runtime`, and refuses any other key. Three observers came after it, `mysql` (DT-91), `mongodb` (ADR 0237) and `sqlite`
(ADR 0239), and each said whether it attached only in the debug log: a MySQL whose driver could not be resolved looked,
in the batch and in `downtrace check`, exactly like an application with no MySQL (DT-97). The stranger campaign met it
reading NodeBB's and hackathon-starter's reports, which had no word for the MongoDB they ran on.

## Decision

**`observers` has a key for every switch of `DOWNTRACE_INSTRUMENT`: `mysql`, `sqlite` and `mongodb` join the four,
in the same minor that adds `sqlite` (0.11.0), with the same three states and the same reading of absence.** The
instrumentation reports `off` when the switch was not asked for, and `on` when a driver resolves from the
application's root or from a package that brings it. **When the switch was asked for and no driver resolves, the key
is left out**, unlike `pg`'s `unavailable`: every switch is asked for by default, and a driver that does not resolve is
almost always a database the application does not use. An `unavailable` for each of them, on every page and in every
`check`, would be a false alarm that buries the one that matters. Absent says «did not say», which is the truth: the
instrumentation does not know whether the application meant to use it.

`check` reads them as it reads `pg`, and the cloud reads them from one list of the switches, where a switch the
protocol adds is one line.

## Alternatives

- **An open map of switches** (`additionalProperties` of `ObserverState`). It would accept a key no reader knows, and
  every reader would then have to decide what an unknown switch means. A closed list is a line per switch.
- **A minor of its own.** 0.11.0 is not published: one minor for the two additions is one version a cloud has to
  accept, and nothing sends either before it is out.

## Consequences

- A sender older than 0.11.0 does not have the three keys, and absent stays «did not say», never «off».
- A MySQL, SQLite or MongoDB driver the application declares and the instrumentation cannot resolve — a bundle, a
  monorepo whose root does not have it — is still said only in the debug log. Telling it from a database the
  application does not use needs the application's declared dependencies, which `check` reads and the instrumentation
  does not; that is the next step, and `unavailable` is the word it would use.
- ADR 0237's and ADR 0239's «`observers` has no key for the switch» no longer hold from 0.11.0 on.
- A switch the instrumentation adds from now on is a key here in the same change, and a test enumerates them from
  `INSTRUMENTS`.
