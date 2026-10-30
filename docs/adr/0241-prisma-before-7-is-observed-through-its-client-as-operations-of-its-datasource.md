# 0241 — Prisma before 7 is observed through its client, as operations of its datasource

Estado: aceptado · Fecha: 2026-10-30 · Amplía el ADR 0209 y el ADR 0240, y el protocolo a 0.12.0 · Alcance: público

## Context

Until Prisma 7 a client queries through an engine of Prisma's own, a native library that talks to the database with no
driver of Node's. No observer saw any of it: every route of a Prisma 3 to 6 application came back `nothing-observed`,
and `init` said `@prisma/client` was not observed (the stranger campaign: a Prisma 4 boilerplate). That is the ORM most
TypeScript backends an agent works on run, and the loop that runs a `findMany` per item is the N+1 a person and a coding
agent write most. Prisma 7, and 6.16 on with `engineType = "client"`, query through a driver adapter, and were already
seen through `pg` or better-sqlite3 (the README's table).

Every operation of a client `prisma-client-js` generates goes through one method of its class, `_executeRequest`, with
the action, the model and the arguments: the operations of a `$transaction`, of an interactive one, of a client
`$extends` made, and the raw queries, whose SQL is in the arguments. The method, its arguments and the instance's
`_activeProvider` and `_engineConfig.adapter` were read the same on 3.15.2, 4.0.0, 4.16.2, 5.22.0 and 6.19.3. The class
is not exported by the runtime, which builds it inside `getPrismaClient` for the generated module to export: the
generated module is the only thing that holds it, and the module cache the only place to reach it from.

## Decision

**A Prisma client's operation is an operation of kind `query` of the dependency its datasource is**, with an empty
`target`: `postgresql` and `cockroachdb` are `postgres`, `mysql`, `sqlite` and `mongodb` are theirs, and SQL Server, for
which the protocol has no dependency, is not observed. **It is labelled by the action and the model** (`findMany Post`),
as MongoDB's commands are by command and collection (ADR 0237), and never by its arguments; a raw query by its SQL, the
tagged template's pieces joined by the database's placeholders and normalised in that database's dialect (ADR 0086,
ADR 0239). What is counted is what the code asked for: an `include` is one operation, and each `findUnique` Prisma
batches in a tick is one.

**The observer is a switch of its own, `prisma`**, said in `observers` from protocol 0.12.0 as ADR 0240 says every switch
is: `on` when `@prisma/client` resolves from the application's root, and the key left out when it does not. It observes
a client and not a driver, and the dependency its operations are is decided by each client's datasource, which is not
known until the client is.

**Armed as the drivers are (ADR 0209)**: at start-up the runtime files of `@prisma/client` are resolved, and nothing is
loaded; at the first request at which one of them is in the module cache, every module of the cache that required it is
a generated client, and the class it exports is patched. That finds the client in `node_modules/.prisma/client` and one
generated into the project's own directory, which never loads `@prisma/client` itself. Under Jest, the copy of each
module whose name has `prisma` in it is patched in Jest's registry, and what is not a client is left alone.

**A client given a driver adapter is left alone.** Its SQL goes through the driver, whose observer counts it in the
request on Prisma 7 and on the query compiler; counting the operation too would count the work twice under one
dependency.

## Alternatives

- **The engine, below the client.** Its `request` and `requestBatch` say what reached the database — a batch of
  `findUnique`s as one — but the engine's class is not exported either, and is reached only from an instance; and the
  native library is not in the module cache. The client's method is one patch on a class the cache holds.
- **Prisma's tracing.** The engine reports each query as a span when an object on `globalThis` asks it to. Asking costs
  about a fifth more per query and a comment on every statement, measured; the README leaves that decision to the user.
- **The switch of the datasource's dependency** (`pg` for a Postgres datasource). The dependency is known per client,
  after start-up, and a switch has to say at start-up whether it attached.
- **Patching `getPrismaClient` before the generated module destructures it.** That needs the runtime loaded at start-up,
  before the application's own load, which ADR 0209 gave up for every observer.

## Consequences

- Prisma 3.15 to 6 on its own engine is observed, and `init` says so from 3.15; a Prisma driver adapter whose driver is
  not observed (`@prisma/adapter-mariadb`) is what `init` names as not observed instead.
- Not seen: a client the `prisma-client` generator wrote as ES modules, one a bundler inlined, one a test runner loads
  outside Node's module cache — Vitest a client generated into the project, measured: only the runtime is in the
  cache —, a client loaded after the first request at which the runtime was, and 5.x or 6.x on the engine with an
  adapter, whose engine calls the driver from a thread of its own.
- What would see all of those: the client asks `globalThis.PRISMA_INSTRUMENTATION` for a tracing helper at every
  operation, which is how `@prisma/instrumentation` hooks in without a patch. A helper that never enables the engine's
  spans would cost the engine nothing; it is one slot, shared with an OpenTelemetry setup, and a next step, not this one.
- Prisma behind Accelerate is counted as its operations and as outgoing HTTP to Accelerate, two dependencies of one
  request: the same work, seen from both ends.
- A `postgres` dependency's labels are SQL for `pg` and postgres.js, and two words for Prisma's operations: a reader of
  labels does not assume SQL. The cloud reads none.
- The agent's tests run a real Prisma 6, whose engine `@prisma/engines` downloads in an install script: the second
  install script the workspace allows, after better-sqlite3's.
