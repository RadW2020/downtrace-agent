# 0203 — The second door waits for the drain already under way

Estado: aceptado · Fecha: 2026-09-28 · Extiende el ADR 0169 · Alcance: público

## Context (gh-690)

An application leaves through two doors that both reach the same drain: `shutdown()`, the public one
(`src/registered.ts`), and `Agent.stop()`, the one `createAgent` users and the instrumentation's own
self-disable use. Both forgot what was draining before the drain was done: `shutdown()` took the agent out
of its module variable before it awaited it, and `stop()` set `started` to false before the last flush. A
second call found nothing and resolved in the instant.

Its caller is usually the one about to `process.exit()`, and a promise that settles in the instant cuts the
first drain's last batch and the evidence of the captures under way: they left with the process, and nothing
said so. The ticket's throwaway test showed it with a cloud that answers in 100 ms and one recorded request:
when the second call resolved the cloud had answered nothing; when the first resolved, it had the batch.

It is not a rare shape. An application that calls `shutdown()` from two places —its own `SIGTERM` handler
and the instrumentation's, which the README recommends it wait for— and the self-disable after its tenth
internal error, which does `void this.stop()` and is followed by the application's `shutdown()`, are both
callers of the second door while the first is still under way. The README said `shutdown()` is «safe to call
twice», and it was so in that it does not throw; not in that it waits.

## Decision

**1. The second call returns the first's promise.** A drain under way is remembered where the door is:
`shutdown()` keeps the drain's promise in its module state beside the agent, and `stop()` keeps it on the
agent beside `started`. A call that finds a drain under way —in the same instant, or a moment later— returns
the same promise, so it waits for what is already going on instead of resolving over it, within the same one
deadline the way out already had (ADR 0157): no second drain starts, and nothing waits twice. When the drain
settles the promise is forgotten: a finished drain holds nothing, and an unconfigured process, or one whose
drain is over, is not held by it.

**2. The alternative leaves the loss in place.** Resolving in the instant and saying so in the README was set
aside. The second caller is precisely the one that is about to exit, and a README line cannot stop its
`process.exit()`: the last batch and the capture evidence still leave with the process, now documented. It
would also have turned the README's existing «safe to call twice» into a sentence true in the weak sense
only, when the code can make it true in the strong one.

## What it does not change

The signal's own flush, which is a leaving flush of its own and already waits for the flush under way
(ADR 0169); the one deadline of the way out, which is not multiplied by the number of doors; the self-disable,
which gets the same promise as any other caller. The README's sentence stands and becomes true in the sense
it was meant to be. A `process.exit()` with no `shutdown()` at all loses what it loses, as the README already
names.
