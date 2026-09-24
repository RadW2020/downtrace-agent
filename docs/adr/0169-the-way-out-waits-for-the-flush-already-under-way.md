# 0169 — The way out waits for the flush already under way, within its one deadline

Estado: aceptado · Fecha: 2026-09-24 · Extiende el ADR 0157 · Alcance: público

## Context (gh-657)

ADR 0157 gave the way out one deadline: `stop()`, and so `shutdown()`, `beforeExit` and a `SIGTERM` or `SIGINT`,
start one `AbortSignal.timeout(SHUTDOWN_FLUSH_MS)` and hand it to the batch and then to each capture's evidence. It
left one case open. The sender has one batch in flight at a time, and `Sender.flush` returns `false` as soon as it
sees one. So a way out that starts while another flush is under way sends nothing of its own. The last interval,
the profile's window `drain()` has just closed, the capture starts and what the application reported last stay in
the sender's queue, and the queue leaves with the process. Nothing says so.

Reproduced on `6b6c126` with a real HTTP server that holds its answers until the test lets them go:

- **The interval's batch in flight.** A request to `/first`, `flushNow()` not awaited, a request to `/last`, an
  explicit report, then `stop()`. When `stop()` resolves the cloud has no batch at all. The one it gets later
  carries `/first` only; `/last` and the report never leave.
- **The interval's flush still sending a capture's evidence**, its batch already landed. `stop()` sends its own
  batch and returns while the cloud is still working on the evidence. A process that calls `process.exit()` next
  cuts that evidence off.
- **A signal's flush under way.** `packages/agent/README.md` recommends `await shutdown()` inside the
  application's own `SIGTERM` handler. The instrumentation's handler was registered by `--import`, before the
  application existed, so it runs first and starts a leaving flush. `shutdown()` then finds that batch in flight,
  sends the capture's evidence itself and returns, and the batch is still waiting for its answer.

With a cloud that answers in milliseconds, each of these needs a shutdown that falls in a narrow gap. With a slow
cloud the gap lasts as long as the flush under way does. ERR-04 (`product.md:376`) asks that each way a process
ends states what it keeps. gh-598's contract says an orderly ending loses nothing the instrumentation was holding,
and that was not true in any of the three cases.

## Decision

**1. A leaving flush first lets every flush already under way finish, bounded by its own deadline.** The agent
keeps the flushes under way in a set: the interval timer's, a signal's, `stop()`'s. A leaving flush reads that set
when it starts, not counting itself, and waits for all of them to settle or for its deadline to pass, whichever
comes first. Only then does it close the interval, drain the profile and take the exceptions, the capture starts
and the local asks. It sends its batch and then each capture's evidence with what is left of the same deadline, in
the order ADR 0157 set.

**2. It waits for the whole flush, not only for the sender's batch.** A flush that is under way does not end when
its batch lands. It then takes the captures whose window has closed and sends their evidence, and a signal's flush
sends the evidence of every capture it took. The way out cannot take those captures over, because they are no longer
under way. Once the batch has landed, which of the two flushes takes a capture comes down to which continuation the
event loop runs first.

**3. It waits before it takes anything, not after.** When the batch in flight lands it wipes the exceptions and
the asks the sender holds for the next batch (gh-626). A way out that took them first would lose them to that
landing, and it has no next batch. gh-626 itself stays with its ticket: this only keeps it off the way out.

**4. When the deadline passes during the wait, the flushes under way are not cut.** Each keeps its own timeout. A
process that lives on still delivers what they carry, and one that exits cuts them either way. The way out then
sends nothing, because nothing it starts can land, and its debug line says the last batch did not land, as ADR 0157
decided.

**5. A flush that is not leaving waits for nothing.** It finds a batch in flight and returns `false`, as before.
The timer fires one per interval, and each waiting behind a slow cloud would pile up, which is the accumulation
invariant 4 forbids. The way out waits once, for as long as its one deadline allows.

## Alternatives

- **Sending its own batch in parallel.** Both batches carry the head of the same interval queue and the same
  exceptions. The cloud discards the repeated intervals and counts the exceptions twice (gh-625). The sender's
  bookkeeping assumes one batch in flight. And the moment every instance of a deploy leaves at once is the worst
  one to double the requests to a cloud that is already slow.
- **Merging: cutting the batch in flight and sending one with everything.** The cloud may already have processed
  the batch that gets cut. Resending it repeats its exceptions, which are counted twice for the same reason, and
  the round trip already spent is thrown away.
- **Waiting for the sender's batch only.** The smallest change: a promise for the batch in flight, and the way out
  waits for it. It fixes the first case and not the other two. When the flush under way is a signal's, or has
  evidence to send, `shutdown()` resolves with that evidence still in flight or not yet started, depending on which
  continuation the event loop runs first. One of the tests turns red with it.
- **Cutting the flushes under way at the deadline.** Every request would need a signal the way out can abort. A
  process that exits cuts them anyway, and one that lives on would lose data it could still have delivered.

## Consequences

- Within the deadline, an orderly ending delivers everything the instrumentation was holding, a flush already under
  way included. Measured against the same held answers: the second batch with `/last` and the report, the evidence
  in flight, and the signal's batch are all answered by the time `stop()` resolves. Before, none were.
- A flush under way that takes the whole deadline leaves the way out nothing. Its own batch is dropped and the
  debug line says so. That is the price of one request at a time, which ADR 0157 chose for the evidence for the same
  reason: the batch that is already in flight goes first.
- Four tests in `packages/agent/test/silent-cloud.test.ts` hold it, each asserting what the cloud has taken by the
  time `stop()` resolves, never how long anything took (ADR 0114). The one against a batch that is never answered
  gives that batch a timeout of its own far beyond the test's limit, so a wait that does not keep the deadline is
  red by vitest's limit. The two that need a slow answer let it go 100 ms after `stop()` starts. The correct code
  passes whenever that and the round trips fit in the deadline. A wrong one is caught whenever a round trip on
  localhost takes less than 100 ms.
- Still open: a second `shutdown()` while the first is still flushing resolves at once, because `registered.ts`
  forgets the agent on the first call and `stop()` returns once it is no longer started (gh-690).
