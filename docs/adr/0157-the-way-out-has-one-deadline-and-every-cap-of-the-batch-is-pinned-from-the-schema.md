# 0157 — The way out has one deadline, and every cap of the batch is pinned from the schema

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-650)

Invariant 4 says that if the cloud does not answer or refuses, the instrumentation drops data: it never blocks and
never accumulates without limit. The sender kept both halves, and no test held either of them whole.

**Never blocks.** Every request the sender makes carries `AbortSignal.timeout`, and nothing checked it. Every sink
in the package's tests answered or refused the connection, and in neither case does a timeout act, so deleting the
signal from the batch or from the evidence left all 458 tests green. Without it, a cloud that takes the connection
and never answers leaves `flush()` pending for ever. `inflight` stays set, and every later flush returns `false`
without sending.

**The way out kept its limit for one request.** `SHUTDOWN_FLUSH_MS` is one second, and the leaving flush gave it to
the batch. Then each capture under way sent its evidence with the sender's default of five seconds, one after
another. Against a cloud that had stopped answering —a `fetchImpl` that settles only when its signal aborts—
`stop()` took 6006, 11006 and 21009 ms with one, two and four captures under way (four is `MAX_LIVE_CAPTURES`).
`shutdown()`, `beforeExit` and a `SIGTERM` or `SIGINT` go through the same flush. So a process whose only `SIGTERM`
listener is the instrumentation's waited all of that before the signal was raised again, and the README recommends
`await shutdown()` inside a `SIGTERM` handler without saying how long it takes.

**Never accumulates.** The batch schema caps four arrays with `maxItems`: intervals (6), capture reports (16),
process exceptions (32) and local triggers (4). The sender's queues stop at the same numbers. Only the intervals'
cap had a test; deleting any of the other three left every test green. Without the exceptions' cap, a process that
saw more than 32 signatures sent a batch the schema refuses. The `400` branch drops that batch's intervals and
profile and keeps the exceptions (ADR 0035), so the next batch was refused the same way, and so was every one
after it.

## Decision

**1. A leaving flush has one deadline for everything it sends.** It starts one
`AbortSignal.timeout(SHUTDOWN_FLUSH_MS)` when it starts and hands it to the batch and then to each capture's
evidence, in that order and one after another. When the deadline passes:

- the request in flight is cut;
- the evidence of every capture not yet started is neither built nor sent, and those captures expire in the cloud
  unless another instance delivers them, which accepting a capture never promised otherwise (CAP-01);
- a last batch that did not land is dropped, and with it what it carried: the final interval, the profile window
  `drain()` closed, the capture starts, the process exceptions and the local asks.

Each loss is said once, in a debug line, and not counted in the resources of a next batch, because a process that
is leaving has none. When the cloud answers in time, every capture under way still hands over its evidence: partial
evidence is an answer, and the deadline is a limit, not a reason to skip it.

**2. The sender takes a deadline.** `Sender.flush` and `Sender.sendEvidence` take a `Deadline`, which is
milliseconds from when the request starts, as before, or an `AbortSignal` somebody already started. Either way the
request carries a signal. The test that holds it is a real server on a real socket that reads the request and never
answers: a flush with a short timeout resolves `false`, counts the failure, keeps the batch, and the next flush
reaches the cloud again. It asserts what reached the cloud and not how long it took (ADR 0114), and a hang is red by
vitest's own limit.

**3. A flush that is not leaving is unchanged.** Each of its requests keeps its own timeout, 5 s by default. Nothing
waits on it: the interval timer fires it with `void`, and each request is bounded already.

**4. Each capped array of the batch has its cap pinned, with the number read from the schema.** The test lists the
top-level arrays of `AGGREGATES_SCHEMA_V0` that declare `maxItems`, hands each queue more entries than that, and
checks the batch carries exactly `maxItems`. It then overfills all of them together and checks the batch validates
against the schema. A capped array the contract gains without a way to overfill it fails. That is what a list
written by hand cannot do. The contract names one trigger signal and the queue keeps one ask per signal, so the
triggers' cap is reached with made-up signals, and only the count is checked there.

**5. Two things stay as they are, on purpose.**

- **The `400` branch keeps exceptions, triggers and capture reports.** With the caps pinned, none of those queues can
  take a batch past the schema. And while the cloud refuses a batch that carries nothing but exceptions (gh-627),
  dropping them on a `400` would lose exceptions that today arrive late, riding the next interval. It is decided
  with gh-627.
- **gh-626 is not folded in.** Exceptions and triggers that reach the sender while a batch is in flight are wiped
  when that batch lands. It is the same function and not the same change: a loss the landing causes, not a wait or
  a cap. gh-625 weighs a cumulative total per signature, which would fix it too, and fixing it here would decide that
  first.

## Alternatives

- **A shorter timeout per evidence**, one second each. The wait still grows with the captures under way, and the
  thing with a limit is the process leaving, not any one request.
- **Sending the evidence alongside the batch**, all under the one deadline. More would land against a slow cloud,
  but at five concurrent requests per instance, to a cloud already slow, at the moment a deploy makes every instance
  leave at once. One after another is the order the flush already had, and the batch goes first because it carries
  the last interval and the capture starts.
- **A longer total.** Nothing here measured how long a leaving process can afford to wait. The one number there is
  is `SHUTDOWN_FLUSH_MS`, which the batch already kept, and a second one would be a guess.
- **Working out what is left of the budget before each request.** The same bound, with arithmetic in the agent and a
  clock that has to be one the network also reads, which `AgentDeps.now` is not in a test. One signal is the deadline
  itself, and `fetch` already takes one.
- **Deriving the three constants in `transport.ts` from the schema at run time.** It would remove the copy, and make
  the shape of a schema document a run-time dependency of the agent. Generating them belongs to the protocol's
  generator (invariant 9), which is a change of its own. Until then the test holds each constant to its `maxItems`,
  in both directions.
- **Faking the clock for the shutdown tests.** Vitest's fake timers do not replace `AbortSignal.timeout`, and a
  deadline the network does not see is not the one under test. The two tests that wait for the deadline take a
  second each.

## Consequences

- `stop()` against a cloud that has stopped answering takes the deadline and no more. Measured with the same
  `fetchImpl` as above: 1002, 1003 and 1003 ms with one, two and four captures under way.
- Against a cloud slower than a second at shutdown, evidence that would have landed in two to five seconds is
  dropped, and the capture expires in the cloud unless another instance delivers it.
- `Sender.flush` and `Sender.sendEvidence` accept a `Deadline`, exported beside `Sender`; a number behaves as it did.
  The changeset is a patch: nothing that compiled stops compiling, and a caret range is what should bring a fix to
  invariant 4.
- The `SIGTERM`, `SIGINT` and `beforeExit` paths have no test of their own against a silent cloud. They call the
  same flush with the same argument, and the deadline is created inside it.
- Still open: a leaving flush that finds a batch in flight sends nothing of its own, because `Sender.flush` returns
  at once while `inflight` (gh-657). An exception signature past its cap is dropped and nothing counts it (gh-659).
  Nothing keeps synchronous I/O out of `packages/agent/src` (gh-658).
