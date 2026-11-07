# 0258 — Under `check`, where Node announces no load, `require` is watched until Jest loads its runtime

Estado: aceptado · Fecha: 2026-11-06 · Matiza el ADR 0209 · Alcance: público

## Context (DT-173)

Jest runs a test file's modules in a registry of its own, and the drivers and the Express the tests use are copies the
module cache never holds. `jest.ts` reaches them by wrapping `requireModule` on the `Runtime` class of `jest-runtime`,
which every `require` of a test file goes through, when `jest-runtime` is loaded. It learns of that load on Node's
`module.require` tracing channel. Node publishes on it from 22.4.0 (nodejs/node#44340), and not on 18.19, 20, or 22.0
to 22.3. The floor is 18.19.0 (ADR 0257), and RF-121 asks that `downtrace check` answer there as it does on Node 24.

Measured on 2026-11-06 with the packed package. The application was Express 4.21.2 with routers mounted under routers
and `pg` 8.13.1, tested by Jest 29.7.0 in band and in two workers. The change added three queries per request to
`GET /api/users/:id`.

- On Node 24.22.2 the route was worse (a query appeared, 0 to 3 per request), and the exit code was 1.
- On Node 18.19.0 the route was named `GET /:param/:param/:id`, with nothing observed in it. The report said «no
  comparison could be made», exited 2, and offered an issue to file.

Every Jest process loads `jest-runtime` through Node's `require` before it reads a test file. The main process loads
it as `@jest/core` builds its contexts, and in band `jest-runner` asks for it again before each file. A worker loads it
as `jest-runner`'s `testWorker.js` is set up. After that, nothing outside Jest leads to the `Runtime` of a test file.
By the first request the file has required the application, its routers are mounted, and the copies are the
registry's. So any moment later than the load misses the file each process runs first, and with two workers that is
every file. Patching at the first request is how ADR 0209 handles drivers and how DT-165 handled Hapi.

## Decision

**Under `check`, in a project where `jest` resolves, and where Node announces no load, the instrumentation wraps
`Module.prototype.require` at its start. It gives `require` back at the first `jest-runtime` whose `Runtime` it wraps,
or when the instrumentation stops.**

- **Asked, not deduced.** Whether Node announces is asked of Node: a `require("node:path")` while listening on the
  channel, as `hapi.ts` asks (DT-175). Where Node announces, nothing here happens, and the channel does the work.
- **The wrapper changes nothing a load does.** It calls Node's `require` on the module that called it, with what it
  was called with, and returns or throws what that did, untouched. Only after the call has returned does it compare the
  id with `jest-runtime`. It hands the result to the same `wrapJestRuntime` the channel's listener uses. A failure of
  its own goes to `internalError` and never to the code that required (invariant 2).
- **For as short a time as it can.** It runs from the instrumentation's start until Jest loads its runtime, and in a
  Jest process that comes before the first test file is read. A `require` that something else wrapped over it in the
  meantime is left in place. The wrapper underneath, which that one calls, then only passes calls through.
- **Only where it is needed.** It runs only in the runs `check` makes, and only in a project where `jest` resolves from
  the application's bases. Never in production, and not under `--import @downtrace/agent/register` outside `check`.

## Alternatives

- **The first request**, the moment ADR 0209 gives a driver and DT-165 gave Hapi. It loses the first test file of
  each process, as the context says.
- **Load `jest-runtime` at start-up**, as DT-175 loads Hapi's `lib/request.js` where Node announces nothing. That
  precedent is one small module of the framework the application itself uses. `jest-runtime` is Jest's core. Its body
  requires `@jest/transform`, `jest-haste-map`, `jest-resolve`, `jest-snapshot` and `graceful-fs`, and `graceful-fs`
  patches `fs.close` for the whole process. It would run in every process of the run, including the package manager's
  and any server a test starts, and before the code that would otherwise load it. The copy would also have to be the
  one `jest-runner` resolves, and under pnpm that is several resolutions away from the project (`jest`, then
  `@jest/core` and `jest-runner`, then `jest-runtime`). Watching `require` runs nothing that Jest does not run itself.
- **A load hook of our own.** `module.registerHooks` arrives in Node 22.15. `module.register` does not see `require`
  on the Nodes that lack the channel. ADR 0209's refusal stands.
- **An accessor on `require.cache` at the path of `jest-runtime`.** Its setter would fire when Node puts the module in
  the cache. It touches one key instead of every `require`, but it has costs. Before Jest loads, it changes what `in`
  and `Object.keys` report about the cache. It needs the exact path of the copy `jest-runner` resolves. And it is still
  in the path of the load.
- **Poll the module cache on a timer.** A worker receives its set-up and its first test file in the same turn of the
  loop, so no timer runs between them.
- **Say why.** The report would say that under Jest this Node does not let the instrumentation see the drivers and the
  mounts, and to run the suite on Node 22.4 or later, with a code of its own and no issue offered. That is honest, but
  it leaves the floor without the runner most Node backends are tested with. It is the answer if this decision is
  refused.

## Consequences

- On Node 18.19 to 22.3, `check` on a Jest suite answers as it does on Node 24. This was measured on the packed
  package on Node 18.19.0, 20.5.1 and 24.22.2 with the scenario above. `scripts/pack-test-jest.sh` runs that scenario in
  CI's `drivers` job on Node 18.19.0 and 24. `check.test.ts` runs Jest 30 and 29, in band and in two workers, on a Node
  that is told nothing is announced. The script fails on the package as it was before this decision.
- ADR 0209 refused «a load hook of our own» for a dependency, for bundlers, for the Node version, and because it would
  sit beside a tracker's hooks. None of those reasons applies here:
  - this needs no dependency;
  - Jest runs no bundle;
  - it covers exactly the Nodes that lack the channel;
  - it is gone before any test file, so before the application and any tracker the application loads.

  A tracker preloaded ahead of `check`'s instrumentation would wrap `require` over it, and this wrapper would then only
  pass calls through. The refusal stands for everything else.
- Still out of reach where Node announces no load:
  - a Jest suite run with `--import @downtrace/agent/register` outside `check`;
  - a project from which `jest` does not resolve, such as Jest brought by `react-scripts` under pnpm;
  - a Jest `runtime` setting other than `jest-runtime`;
  - a second copy of `jest-runtime` in one process;
  - Jest's ESM mode, which no Node reaches.
- The cost is one function call and one comparison per `require`, from the start until Jest loads its runtime. The
  processes of a Jest project's run that never load it, such as the package manager's or a server a test spawns, pay it
  for their whole life.
