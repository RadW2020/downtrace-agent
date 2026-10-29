# 0236 — Hono's routers are wrapped at start-up, before they are given their routes

Estado: aceptado · Fecha: 2026-10-29 · Amplía los ADR 0209 y 0235 a un framework · Alcance: público

## Context

Hono is the framework most new Node backends start on, and the one coding agents reach for first. Its testing guide
calls an application with `app.request()`, which builds a `Request` and hands it to the application's `fetch`: no server
listens, Node announces nothing, and a suite written that way was, for `downtrace check`, a run that called no route —
`no-profile` (the stranger campaign of 2026-10-29). Served by `@hono/node-server`, a Hono application's requests are
Node's, but nothing named them by their routes: the heuristic over the path did.

Fastify's `inject()` was the same hole, and Fastify announces each instance it creates, so its hooks open and close the
request. Hono announces nothing and keeps nothing to hook on its prototype: `fetch` and `request` are fields of each
instance, the dispatch is a private method, the context's helpers are fields too, and each router replaces its own
`match` on the instance the first time it runs. What every route goes through is a router's `add`, on the prototype of
each router Hono ships (`RegExpRouter`, `TrieRouter`, `LinearRouter`, `PatternRouter`), which receives the handler beside
the route Hono registered it with. A handler wrapped there runs with the request's context, inside Hono's dispatch, and
the first one to run for a request is the outermost.

The moment is the problem. `new Hono()`'s router, `SmartRouter`, keeps the routes and gives them to `RegExpRouter` (or
`TrieRouter`) at its first match — the first request — and never again. ADR 0209's moment is the start of the first
request, and ADR 0235's import is scheduled from there, so both come after the routes have been given: every route of
the process would be missed, not one request. Under `app.request()` there is no first request at all.

## Decision

**The instrumentation loads Hono's four router files at start-up, both copies — the CommonJS one with `require`, the ESM
one with `import()` of the file's URL — and wraps `add` on each router class. Each handler a router is given is wrapped:
the first that runs for a request names it by the first route it matched that is not a middleware, and opens the request
if Node did not announce it.**

- **Only the router files.** They import nothing of the application and do nothing when evaluated; Hono's entry, its
  `Hono` class and its `hono.js` — what a tracker hooks — are left for the application to load. A tracker registered
  after us sees them load as it would without us: ESC-16 holds, which is what 0235 refused a start-up import for.
- **Both copies,** because which one the application loads is not known at start-up: `import "hono"` and `require("hono")`
  load different files. The CommonJS copy is in before the application's entry runs. The ESM import is not awaited,
  and resolves before an entry that imports Hono has been loaded, because that entry's graph contains these files and
  more; `SmartRouter` gives its routes at the first match, so the default router has until the first request anyway.
- **The name** is the path of the first matched route that is not a middleware (`use()`: every method, a path ending
  in `*`), as Hono registered it — the sub-application's prefix included. A request no route matched is
  `(unmatched)` (ADR 0231).
- **A request Node did not announce** is opened when its first handler runs, apart from the code that called
  `app.request()`, and closed when that handler settles, with the status of the response it gave or the one Hono kept
  on the context. When that handler throws, Hono's error handler answers after it and out of reach: the status is the
  error's own, for an `HTTPException`, or 500, as Hono's default handler answers.
- **Under Jest,** the tests' copy is wrapped as it is required (`jest.ts`).

## Alternatives

- **Wrap `match`.** What was proposed first: it is on the prototype, but each router replaces it on the instance the
  first time it runs, so a wrapper would see one request per router.
- **From the first request, as 0209.** Too late by construction for `SmartRouter`, and never for `app.request()`.
- **Wrap the application's `fetch`.** It is a field of each instance, and nothing reaches the instances: the class is a
  live ESM binding and its constructor calls nothing patchable.
- **A load hook** (`module.registerHooks`, import-in-the-middle) to wrap the `Hono` class. Refused by 0209 and 0235, and
  for the same reasons.
- **Ask the application** to add a middleware. A suite run by a coding agent would still be blind until someone did.

## Consequences

- A process that resolves `hono` loads its routers, eight small files, at start-up, whether it serves with Hono or not.
- An application that hands Hono a router itself — `hono/tiny`, `new Hono({ router })` — gives that router its routes as
  it registers them; the ESM wrapper is in before that in practice, not by construction.
- The status of a request whose first handler threw is the default handler's, not a custom `onError`'s: a request
  served through Node's server has its real status, and one made with `app.request()` and answered by an `onError` of
  its own is reported as Hono's default would have answered. Said in the package's README.
- A Hono application's routes are declared for `check` from what its routers were given (ESC-18), as Express's and
  Fastify's are.
