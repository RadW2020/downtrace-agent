# 0247 — Listening for loads starts at the first request, and the attach takes the driver through `require`

Estado: aceptado · Fecha: 2026-10-31 · Matiza el ADR 0246 · Alcance: público

## Context

ADR 0246 listened for loads from the instrumentation's start, and took the driver off the module cache, not through
`require`, so that a `require` of its own would not be the first a tracker's hook for CommonJS saw. A review measured,
with `@sentry/node` 10.75.0 and `pg` 8.23.0, what that broke: an application whose `pg` comes in two ways, an
`import` and a `require`. An ES module application that imports `pg`, beside a CommonJS dependency that requires it —
knex's client, TypeORM's driver, connect-pg-simple —, or a CommonJS application that requires `pg` and imports it from
an ES module during start-up. The tracker hooks each way once, and its second hook unwraps its first wrapper only when
that wrapper is on top. The patch in the microtask after the first load put this observer's wrapper on top before the
second way came, and the tracker's query spans came out twice, in both load orders. Before ADR 0246 they were one: the
patch came at the first request, after start-up had loaded `pg` both ways, and its own `require` had been the first
the tracker's hook for CommonJS saw, so a later `require` of the application's was a hit in that hook's cache.

## Decision

**The load listener starts at the first request, after that request's attach, and only if the attach left a driver
unpatched. The attach takes the driver through `require` again — a cache hit, once the module is loaded.**

- **Start-up keeps ADR 0209's moment.** Whatever the application loads before it answers is patched at the first
  request, after every way it came in has been seen by a tracker's hooks: the order measured with a tracker beside it.
- **What loads in a request is patched after its load.** A route Next.js loads as it is first asked for, a lazy
  import in a handler: what ADR 0246 is for, and what its tests measure, holds.
- **Through `require`.** The attach's `require` is the first a tracker's hook for CommonJS sees of a driver the
  application imported, so the tracker patches it there, under this observer's wrapper, and a `require` of the
  application's later on is a hit in that hook's cache. `loaded` is still asked first: a `require` of a module the
  ES module loader has only linked would run it ahead of the application.

## Alternatives

- **Patch each class as the module that defines it ends loading**, so this observer's wrapper is under every one of
  the tracker's, whatever the order. It is the one that holds in every order, and it is a patch per class and per
  driver, against the internals of each: not for a correction.
- **Keep listening from the start, and `require` in the microtask.** It covers the `import` first and the `require`
  after, and not the `require` first and the `import` after: the tracker's hook for ES modules comes later, on top.

## Consequences

- A test runs both ways in, before the first request and after it, in both load orders and beside the tracker alone,
  with no database: `packages/reference-app/test/two-ways-in.test.ts`.
- What is still lost: the first query in a request that loads the driver both ways — a `require` and an `import` of
  it inside the same request —, which comes out twice in the tracker; and, as ADR 0246 says, Node 20, ES module
  drivers, and a query in the same turn as the load. Also an application whose loader hook hands Node the source of a
  CommonJS module: Node runs it through the ES module loader, and announces no load.
- A copy that resolves and never loads — a `pg` that `@prisma/adapter-pg` brings and the application does not use, an
  ES module driver, a driver under Jest's registry — keeps the listener for the life of the process: one microtask per
  run of loads after the first request, which is few.
