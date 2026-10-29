# 0235 — An ESM driver is imported by its own file, from the first request

Estado: aceptado · Fecha: 2026-10-29 · Amplía el ADR 0209 a un driver que se carga como ESM · Alcance: público

## Context

postgres.js (`postgres`) is the Postgres driver of Drizzle's `drizzle-orm/postgres-js` and of most Supabase backends,
and the largest hole left in what the instrumentation sees: an application on it had no database work at all, in
production and under `downtrace check`. It is a dual package: `cjs/src/` for `require`, and `src/` for `import`.

ADR 0209's mechanism does not reach the ESM copy. It resolves the driver at start-up, loads nothing, and patches it
from the first request at which the application's load put it in `require.cache`. An `import "postgres"` loads
`src/index.js` through the ESM loader, which has no cache a library can read: the attach would wait forever. The
alternatives 0209 refused are still refused — a load hook of our own (a dependency, a failure point with bundlers,
`module.registerHooks` above the Node 20 floor, and a hook beside the tracker's, competing for the loads ESC-16 is
about), and asking the application to call us.

What the patch needs is not the module the application imported but one class it contains: every query postgres.js
runs is a `Query` (`src/query.js`, a `Promise` subclass), and the first call to `Query.prototype.handle` executes it,
in the context of the code that awaited it. That file imports nothing and does nothing when it is evaluated. The ESM
loader keys its modules by URL, so a dynamic `import()` of that file's URL returns the very module, and the very
class, the application's `import "postgres"` loaded or will load.

Sentry's own postgres.js integration hooks the same method, by transforming `query.js` as it is loaded. A tracker of
that kind sees the file only if its hook is registered before the file is loaded the first time.

## Decision

**For the ESM copy of postgres.js, the instrumentation imports the driver's query module itself, by the URL of the
file the application's import loads, from the first request — and patches `Query.prototype.handle`. The CommonJS copy
is patched as ADR 0209 patches `pg`.**

- **Start-up resolves and loads nothing**, as 0209: `require.resolve("postgres")` from the application's entry gives
  the package's root; its `package.json`, read by path because the package exports none, gives the version.
- **The import is from the first request, outside its path.** The first attach schedules it with `setImmediate`, so
  the resolution the loader performs is not inside that request (invariant 1). By the first request a tracker loaded
  with `--import` has registered its hooks, so its hook sees our load if the application had not loaded the file
  yet, and nothing if it had: the module is the same either way.
- **What that moment gives up is said:** queries that start before the import resolves are not counted — in practice
  the first request's. It is 0209's loss, one request wider.
- **Under `downtrace check` the import starts at start-up.** A test file's first request is a test; losing it would
  lose the same request from both runs, and a regression on a route only that request reaches would be seen by
  neither. A test run is not the production composition ESC-16 protects, and the preload `check` adds comes after any
  the project's own `NODE_OPTIONS` names.
- **One wrapper, on the class, with a mark.** The wrapper takes the request when `handle` first runs and wraps the
  two callbacks the driver settles that query with; a failure of its own goes to `internalError` (invariant 2), and
  the application's query runs as it would.

## Alternatives

- **Import the file at start-up, always.** It loses no request, and it pre-empts a tracker whose hooks are registered
  after ours: the tracker never sees `query.js` load and loses every postgres.js span — ESC-16 broken whole, to save
  one request.
- **`require()` of the ESM file**, synchronous from Node 20.19 and 22.12. It would patch before the first handler
  runs, but it reads the file synchronously when the application has not loaded it yet, inside the request
  (invariant 1), and it is not there on the Node 20 releases before 20.19.
- **A process-wide promise hook** (`v8.promiseHooks`, `async_hooks`) to catch the first `Query` constructed and take
  its prototype. A cost on every promise of the process for as long as the hook lives, to find one class.
- **Wrap the `sql` instance.** The application creates it, and the module's default export is a live ESM binding
  that cannot be replaced from outside.

## Consequences

- postgres.js is observed under the `pg` switch, as dependency `postgres`; the batch's `observers.pg` is `on` when
  either driver resolves.
- A postgres.js query does not know its connection, so its dependency has **no target**: a replica and a primary
  reached through it are one dependency. The wait for a connection is inside the driver and is part of the query's
  time. Both are said in the package's README, not found.
- A process with `postgres` installed and never imported loads one 150-line module it does not use, once.
- The next driver that ships only ESM is this ADR's case, and its first question is the same: which file holds the
  class whose method executes the work, and does it import nothing.
