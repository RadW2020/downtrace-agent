# 0246 — A driver is patched as the application loads it, in the microtask after the load

Estado: aceptado; matizado por el ADR 0247: se escucha desde la primera request, y el attach toma el driver con `require` · Fecha: 2026-10-31 · Amplía el ADR 0209, y levanta, desde Node 22, lo que su momento perdía · Alcance: público

## Context

ADR 0209 patches a driver from the start of the first request at which the application has loaded it, and says what
that moment gives up: a query the application makes in the very request that loads the driver is not counted. It took
that loss because the one way to close it it knew of was a load hook of our own, which it refuses.

The loss is not the rare case 0209 thought. Next.js loads a route's module, and with it the driver the route queries
through, inside that route's first request, in production as in development. Measured, a Next.js 15 application run
from Playwright's `webServer`, with `pg`, read its lookups of 1 → 4 as 0.67 → 2.67. The verdict was right, but only
because each test calls the route more than once. A suite that calls each route of an API once, which is the usual
shape of one, leaves such a route `nothing-observed` under `downtrace check`. And in production, every process loses
the first request of every route that loads its driver lazily.

From 22, Node announces every load of a CommonJS module on its `module.require` tracing channel. That includes one an
ES module imports, and a `require` of a package's entry or of a module inside it. Listening loads nothing, and changes
nothing the loader does, so it is not the load hook 0209 refuses.

## Decision

**The instrumentation listens on `module.require` from its start, and in the microtask after a run of loads asks each
driver's observer to attach: the same attach as the request's, which reads the module cache. It stops listening once
every observer has settled. The attach at the start of a request stays.**

- **In the microtask after the load, and not at the end Node announces.** A driver loads its classes one module at a
  time, and `mysql2`'s connection has finished loading before its pool starts. A tracker's hook on `require` patches
  what it loaded only once that `require` has returned, after the end the channel announces. Measured with
  `@sentry/node` 10.75.0 in the reference application: its instrumentation of `pg` patches `Client.prototype.query`
  twice, once as `pg/lib/client.js` loads and once as it is handed `pg`'s entry. The second unwraps the first before it
  wraps, when it recognises it. A patch at the end of the outermost load put this observer's wrapper between the two,
  and with Downtrace loaded first the tracker's `pg` spans came out twice, the way 0209's table found them. In the
  microtask the driver is whole and both of the tracker's patches are under this observer's, as they are when the
  first request patches it. It is still before anything the code that loaded the driver waits for. A handler that
  `await`s an `import()` goes on in a later microtask. A query waits for a connection.
- **Off the cache, once loaded, and not through `require`.** The ES module loader puts a CommonJS module it imports in
  the cache as it links the graph, to read its exports, and runs it later. An attach in between found `pg`'s `Client`
  missing and gave up on the copy, and the reference application was not observed at all. So the attach takes a module
  whose `loaded` is true. And it takes the exports from the cache, because an ES module application's load of `pg` is
  not a `require`. A `require` from the attach would have been the first one the tracker's hook for CommonJS saw, and
  the tracker would have patched the driver there and again at its hook for ES modules. The request's attach reads the
  cache the same way, so a request that starts while another one's lazy import is still linking does not give up on
  the driver either.
- **What the load cannot do stays with the request.** Node 20 announces nothing. An ES module driver — postgres.js's
  ES copy, `mariadb` from 3.5 — never enters the module cache, and is imported by its file from the first request
  (ADR 0235). Prisma 4 to 6 are looked for in the whole cache at requests that are powers of two (ADR 0242).

## Alternatives

- **At the end Node announces, at the outermost load.** It was the first version, and the tracker's spans doubled, as
  measured above.
- **The `module.import` channel**, whose end comes before the code awaiting a dynamic `import()` goes on. It announces
  `import()` only. A `require` inside a handler, which is how the Next.js server loads a package it keeps out of its
  bundle, is not on it. The CommonJS load inside an `import()` is on `module.require` anyway.
- **`setImmediate`.** It comes after the microtasks in which a handler goes on from `await import()`, and so after its
  first query.
- **A load hook of our own** (`module.registerHooks`). 0209's refusal stands.

## Consequences

- From Node 22, the queries of the request that loads a CommonJS driver are counted: `pg`, `mysql2`, `mysql`,
  `mariadb` up to 3.4, `mongodb`, `tedious`, `better-sqlite3`, `libsql`, `sqlite3` and postgres.js's CommonJS copy.
- What is still lost is said:
  - a query the code makes in the same turn as the `require` that loads the driver, for example
    `require("better-sqlite3")` and a statement right after it, or `new Client().query()` right after `require("pg")`;
  - a driver imported as an ES module;
  - Node 20.
- The cost is one microtask for each run of loads until every observer settles. A process that never loads a driver
  its root resolves keeps listening, at a few property reads per run of loads, as it pays one per request today.
- The coexistence test (ADR 0147) is what found the doubled spans, and it is what guards the moment.
