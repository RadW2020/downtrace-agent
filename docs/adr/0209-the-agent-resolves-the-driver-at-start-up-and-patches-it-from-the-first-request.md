# 0209 — The agent resolves the driver at start-up, and patches it from the first request

Estado: aceptado · Fecha: 2026-09-28 · Supera la parte del ADR 0009 que cargaba el driver al arrancar · Alcance: público

## Context (gh-614)

`product.md` asks, in ESC-16, that with the tracker Downtrace is meant to replace loaded in the same process
«each instrumentation observes what it would observe alone». ADR 0147 measured that against `@sentry/node`
10.75.0 and found the `pg` half broken in both load orders:

| configuration | `pg-pool.connect` spans | query spans |
| --- | --- | --- |
| the tracker alone | 3 | 3 |
| the agent, then the tracker | 0 | 3 |
| the tracker, then the agent | 3 | 6 |

The cause is the second decision of ADR 0009: the agent resolves `pg` from the application's root and
**requires it at start-up**, so that the instance the application loads afterwards is the one already
instrumented. That require executes `pg`'s body, and `pg`'s body requires `pg-pool`. A tracker that
instruments `pg` by hooking module loading then meets the cache in two different ways, one per order: load
the tracker second, and `pg-pool`'s body ran before any hook existed, so its connect span is never made;
load it first, and the application's own `import "pg"` names a module the hook has already wrapped once, and
the hook wraps it again on top of a wrapper that does not carry its mark.

The fix has to keep everything ADR 0009 keeps — the patch on the prototype the application actually uses,
resolved from the application's root, no loader hooks, no dependency, ESM and CommonJS alike — and give back
the one thing the tracker needs: that the application's own load of `pg` is the only load its hooks ever see.

## Decision

**The agent never loads `pg`. It resolves it at start-up, and it patches it from the first request at which
the application has loaded it.**

- **Start-up resolves and does not load.** `require.resolve("pg")` from the application's root says whether
  there is a driver to instrument, and reading `pg/package.json` says which version the batch reports — the
  same fact the old start-up require read, at the same moment. Neither executes the driver, and neither fires
  a module-load hook, so a tracker's hooks see nothing the agent did. When there is no `pg` to resolve, the
  observer is «unavailable» exactly as it was before, and its attach settles at once.
- **The patch runs in `attach`, from the start of the request.** The `http.server.request.start` subscriber
  is where the request's context already goes in (ADR 0009), and it is before the handler runs. Until the
  resolved path is in the module cache the driver has not been loaded, and a query cannot have run: there is
  nothing to patch and nothing is lost by waiting. Once it is, the `require("pg")` the attach performs is a
  cache hit that re-executes nothing, and the wrapper lands on the prototype before the handler's first query.
- **The attach is once per request until it settles, and is nothing after.** It is a property read on the
  module cache and a call; when it settles the agent drops the reference, and the steady state is the property
  read of a field that no longer has one.
- **The patch itself is what it was.** The wrapper on `Client.prototype.query`, the wait on
  `Pool.prototype.connect`, the symbol marks that keep it to one, and the same failure boundary: anything the
  wrapper's own code throws is an internal error of the instrumentation, never a change in what the
  application's query does.

## Alternatives

- **Copy the tracker's wrap mark onto our wrapper**, so its hook recognises what is already wrapped and does
  not stack. ADR 0147 refused it and it still loses: the tracker would unwrap before re-wrapping, and
  unwrapping removes us. It is also a game played on the tracker's internals, a new breakage on every bump,
  for a composition this project is supposed to survive.
- **A load hook of our own** (`module.registerHooks`, or `import-in-the-middle` behind `module.register`).
  ADR 0009's refusal stands: a dependency in the public package, a failure point with bundlers, and
  `module.registerHooks` needs Node 22.15 while the agent's floor is 20. On top of that it would sit beside
  the tracker's own hook — competing for the very loads gh-614 is about, instead of staying out of them.
- **Load `pg` at start-up and delete its cache entry**, so the application's load runs the body under the
  tracker's hooks. The body runs twice — once per process that loads it — and the second run is exactly the
  second load the tracker's hook re-wraps: the tracker-first row of the table, moved, not fixed.
- **Ask the application to call `instrument(pg)`.** ADR 0009's refusal stands: the product's promise is one
  library and one variable, and the reference application may not import the agent at all.

## Consequences

- The second decision of ADR 0009 — «parchea el prototipo al arrancar» — is superseded in the moment, not in
  the mechanism: the patch is still on the prototype resolved from the application's root, with no loader
  hooks and no dependency. The Estado line of 0009 says so.
- The measurement ADR 0147 wrote down as «what is not, and is written down rather than hidden» is now the
  test that guards it: the three configurations assert the tracker's own spans — one connect and one query
  per request, with the tracker-alone run as the baseline in the same test. The table stays in 0147 as the
  measurement that found the bug; its Estado line says the limit is lifted.
- The moment gives up one thing, and it is said rather than found: a query the application makes in the very
  request that loads the driver for the first time — a lazy import inside a handler — is not counted in that
  request, and is counted from the next. An application that imports the driver where it imports the rest
  (the reference app's shape, and the only shape the product's promise describes) loses nothing. The
  alternative that would close even this gap is the load hook the Alternatives refuse.
- A process that answers a request has finished loading, so the attach settles within the first requests of
  any real application; a process that never loads the driver pays the property read for as long as it
  answers requests and never pays the patch.
- What the mirror will measure, and what this does not say: the cost of the attach on the request path, and
  the cost half of ESC-16 with the tracker present. Those are readings of the coexistence campaign (gh-615),
  not claims.
