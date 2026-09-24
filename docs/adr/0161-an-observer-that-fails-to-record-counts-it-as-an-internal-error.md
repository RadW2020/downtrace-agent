# 0161 — An observer that fails to record counts it as an internal error

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-663)

The outgoing HTTP and Redis observers (`packages/agent/src/instrument/http.ts`, `redis.ts`) record from
`diagnostics_channel` subscribers, and recorded with no guard. Node calls every subscriber inside a `try` of its
own and rethrows what it catches on `process.nextTick` as an uncaught exception, so a failure while recording
ended the application's process. The `fetch` wrapper, the one place outgoing HTTP is touched rather than
listened to, recorded inside its own `catch`, and a call that failed rejected with the instrumentation's error
instead of `TypeError: fetch failed`. Measured with the request's exclusion list throwing: an uncaught exception
on six of the seven paths, and our error instead of the application's on two.

A guard answers the first half of invariant 2 —«never throws exceptions into the user's code»— and leaves open
what the failure is reported to. There were two answers in the package:

- **The hooks of `agent.ts`** —the start and the end of every incoming request, `captureException`, the
  control channel— run through `guard`, whose `catch` calls `internalError`: the failure is logged at debug,
  counted in `internalErrors`, which travels in the batch (ADR 0113), and at the tenth the instrumentation
  disables itself. That is the second half of the invariant, «An internal failure disables the
  instrumentation», and `product.md:241`, «An internal error disables it».
- **The `pg` observer** catches a failure while recording and writes it with `log.debug`, and nothing else
  (gh-652 extended that to the connection wait). A failure that repeats on every query is logged on every
  query, counted nowhere, and never disables anything: the queries disappear from the data and neither the
  count nor the batch says why.

## Decision

**1. An observer hands a failure of its own to the agent's `internalError`.** `instrumentHttp` and
`instrumentRedis` take `{ log, internalError }`, and `agent.ts` passes a closure over its own `internalError`.
A failure while they record is therefore one of the instrumentation's own, like a failure in any hook of
`agent.ts`: logged at debug with its stack, counted, reported in the batch and, at the tenth, the end of the
instrumentation. ADR 0080 already said why the tenth is right for a bug: «un agente con un bug es peor que
ninguno».

**2. One guard per observer, at subscription.** Each observer wraps every subscriber it subscribes in one `try`
whose `catch` calls `internalError` and returns, so the start of a call is covered as well as its end, and a
channel added to the list is covered with nothing to remember. The `fetch` wrapper is not a subscriber: it
records its connection failure inside a `try` of its own, and rethrows the application's error after it
whatever happened.

**3. `pg` joins the rule in gh-670, not here.** Its guards stay as they are in this change; until then it is
the one observer whose failures are only logged.

## Alternatives

- **Log at debug, as `pg` does.** Consistent with the nearest observer, and it keeps a failure that repeats for
  ever invisible: nothing reaches `internalErrors`, nothing travels, nothing disables. It meets the first half
  of invariant 2 and not the second.
- **Hand the observers the agent's `guard` instead of its `internalError`.** It reports the same way and also
  times the hook in the overhead meter of ADR 0080. That changes what `overheadPerRequestMs` measures and what
  the shedding decides on —the observers' hooks have never been in it— and costs a closure per event on the hot
  path of every outgoing call. Whether the meter should see them is a question of its own, answered with a
  measurement, not a side effect of this one.
- **A `try` inside each handler.** The same coverage today, and a seventh channel added tomorrow without one is
  the gap this closes, back again.

## Consequences

- A bug that makes an observer's recording throw now disables the whole instrumentation after ten calls,
  incoming requests included. That is what invariant 2 asks for, and the application goes on being answered.
- `internalErrors` in the batch now includes the observers' failures, so the cloud sees them as a loss of the
  instrumentation, not as a service that stopped calling its dependencies.
- The tests drive every path of both observers with the instrumentation's own code failing, compare what the
  application got with the same call made outside a request, watch `uncaughtExceptionMonitor`, and check the
  count through the real agent; each new `catch` turned into a rethrow or emptied turns its rows red.
- `runtime.ts` has no guard: its one callback adds two numbers Node hands it, and nothing of the
  instrumentation's that can fail runs there.
