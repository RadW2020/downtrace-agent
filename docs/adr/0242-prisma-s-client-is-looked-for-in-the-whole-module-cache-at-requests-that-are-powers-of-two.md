# 0242 — Prisma's client is looked for in the whole module cache, at the requests that are powers of two

Estado: aceptado · Fecha: 2026-10-30 · Corrige el ADR 0241 y amplía el ADR 0209 · Alcance: público

## Context

ADR 0241 armed Prisma by resolving the runtime files of `@prisma/client` from the application's root, and patching, at
the first request at which one of them was in the module cache, the classes of the modules that had required it. It
said that found a client generated into the project's own directory too. It did not: Prisma 6 copies its runtime into
that directory (`generated/prisma/runtime/library.js`) and the client requires the copy, so no module required the
runtime that was resolved. An application Node ran with such a client — what Prisma 6 asks for, and warns without — had
every route `nothing-evaluated`. Jest's, found by name, did not show it, and the tests had no application Node ran with
one.

Where the copy is cannot be known at start-up: the directory is the project's to name. ADR 0209's attach costs one
property read per request until it settles, because it knows the path to read.

## Decision

**The runtime is recognised by where it sits and what it exports** — a `runtime/library.js` (or `binary.js`,
`index.js`, `edge.js`, `data-proxy.js`) whose exports have `getPrismaClient` — **anywhere in the module cache, and the
clients are the modules that required one.** The cache is looked at whole, so not at every request: at the 1st, the
2nd, the 4th and every power of two up to the 1024th, and never again once a client is found. An application that
declares Prisma and never loads it pays for eleven looks.

## Consequences

- A client generated into the project is found, whatever the directory is called, in Node and under Jest.
- A client loaded later than the request that finds the first one, or after the 1024th request, is not seen: a second
  schema imported lazily, for one. ADR 0209's lazy-import case loses one request; this one can lose more, up to the next
  power of two.
- A look reads every key of the module cache once, with a pattern: in a process with thousands of modules that is
  under a millisecond, eleven times at most.
