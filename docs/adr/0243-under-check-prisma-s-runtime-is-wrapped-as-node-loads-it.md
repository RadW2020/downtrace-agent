# 0243 — Under `check`, Prisma's runtime is wrapped as Node loads it

Estado: aceptado · Fecha: 2026-10-30 · Amplía el ADR 0241 y el ADR 0242, y se aparta del ADR 0209 bajo `check` · Alcance: público

## Context

ADR 0241 and ADR 0242 reach a Prisma client through the module cache: the class its generated module exports, found
among the modules that required a runtime of Prisma's. Vitest runs the modules of the project's own directory itself,
outside Node's cache, so a client `prisma-client-js` generated into the project — what Prisma 6 asks for, and warns
without — is never in it; only the runtime beside it is, which the client still loads through Node's `require`.
Measured: under `downtrace check`, a Vitest suite on such a client had every route `nothing-evaluated`. Vitest is the
runner of most TypeScript projects a coding agent starts, and `check` runs their suites.

The class is made inside the runtime's `getPrismaClient`, which the generated module calls as it loads, before any
request; the runtime exports it as a getter that cannot be redefined. Nothing else holds the class.

## Decision

**Under `check`, and only there, the instrumentation wraps Node's loader (`Module._load`) at start-up: a module that
exports `getPrismaClient` and sits where a runtime of Prisma's does is handed over as a copy of its exports whose
`getPrismaClient` patches the class it makes**, and the module cache holds that copy, so every later `require` gets
it. Every other module costs one property read as it loads.

ADR 0209 resolves and loads nothing at start-up, and hooks no module loading, so that a tracker that hooks the loading
of a driver sees it as it would alone, and so that production pays nothing at start-up. Neither applies here: no
tracker hooks Prisma's runtime — its own instrumentation reads `globalThis` —, and `check` runs a project's tests, not
its production, as postgres.js's early import does (ADR 0235). In production the cache is looked at as ADR 0242 says.

## Alternatives

- **`globalThis.PRISMA_INSTRUMENTATION`**, the slot Prisma's own tracing reads at every operation. It is called with
  the operation's action and model, and not with the client: no datasource, so no dependency to put it under, and no
  SQL for a raw query. And it is one slot, an OpenTelemetry setup's.
- **Loading the runtime at start-up and replacing its exports in the cache.** A client generated into the project
  requires a copy of the runtime beside it, at a path the project names, which start-up cannot know.

## Consequences

- Under `check`, a client Vitest runs from the project's directory is observed, as one Node or Jest loads is.
- Outside `check` such a client is still not seen; it is a test runner's, and production loads through Node.
- A client the `prisma-client` generator wrote — what `prisma init` writes in 6.19 — is still not seen, in Node or
  under Vitest: it imports the runtime as ES modules, and `@prisma/client` hands an `import` its `runtime/library.mjs`,
  whose `getPrismaClient` is a binding nothing outside it can replace; measured, the class it makes has
  `_executeRequest` and the wrap never sees it. Reaching it means rewriting that module's source in a loader hook. On
  Prisma 7 the same client queries through a driver adapter, and is seen through the driver.
- A client a bundler inlined with its runtime is not seen either: its runtime is not a module of its own.
