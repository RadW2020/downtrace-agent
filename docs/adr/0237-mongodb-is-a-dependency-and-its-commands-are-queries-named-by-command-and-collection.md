# 0237 — MongoDB is a dependency, and its commands are queries named by command and collection

Estado: aceptado · Fecha: 2026-10-29 · Amplía el ADR 0011 y el protocolo a 0.10.0 · Alcance: público

## Context

MongoDB, through Mongoose most of the time, is the database of most Express boilerplates, and the instrumentation did
not see it: a route whose work went to MongoDB was a route with nothing inside, and `downtrace check` evaluated none of
them (the stranger campaign of 2026-10-29: `hagopj13/node-express-boilerplate`, every route `nothing-observed`). The
protocol had four kinds of dependency — `postgres`, `mysql`, `redis`, `http` — and the schema refuses a fifth.

Every command the official driver sends, Mongoose's included, goes through one method: `Connection.prototype.command`
in `lib/cmap/connection.js`, the same shape in the 6.x and 7.x drivers (Mongoose 8 and 9). It is called in the context of
the code that asked, also when the pool queues the request for a connection: the continuation is the awaiter's. The
driver's own command monitoring needs `monitorCommands` from whoever builds the client, and Mongoose 9's tracing
channels are Mongoose's alone.

## Decision

**`mongodb` is a kind of dependency (protocol 0.10.0). The instrumentation wraps `Connection.prototype.command` of the
driver the application loaded, under a `mongodb` switch, and each command a request sends is an operation of kind
`query`, named by the command and the collection: `find users`, `insert orders`, `aggregate events`.**

- **One dependency, no target**, as postgres.js: a replica set's members, the primary and the secondaries a read goes
  to, are one database to the application. Its time and its failures are the dependency's.
- **The label is two words and nothing else.** The command's name, the first key of the document the driver sends, and
  the collection it names, when that is a string; never the filter, the documents, the pipeline or the update, which
  hold the data (invariant 5). A collection whose name looks like a value — `tenant_8f3a…`, a number — is `?`, so a
  collection per customer is one operation and its name does not travel. A command whose name is not a plain word is
  counted against the dependency and is not an operation.
- **`query`, not a new kind of operation.** The schema says a `query` is a query to a database, and a MongoDB command is
  one; the text is the normalised label it already carries for SQL. A new kind would ask every reader to learn it, and
  give them nothing they do not have.
- **The driver's own conversation is not the request's:** the handshake and authentication of a new connection
  (`hello`, `isMaster`, `saslStart`, `saslContinue`) and `endSessions`. A command outside a request is not counted, as a
  query is not.
- **A failed command** is one the driver rejected, or one the server answered with write errors or a write concern
  error: an insert that broke a unique index answers `ok: 1` and is a failure all the same.
- **When:** as `pg` (ADR 0209): resolved at start-up from the application's root and from Mongoose's, which brings its
  own (DT-92), loaded never, and patched from the first request at which the driver is in the module cache. The driver
  ships only CommonJS, so an `import` puts it there too. Under Jest, the tests' copy is patched as it is required.

## Alternatives

- **The driver's command monitoring.** It needs the option where the client is built, which is the application's code.
- **Mongoose's tracing channels.** Mongoose 9 only, and not the driver beneath it.
- **The filter's keys in the label** (`find users {email}`), to tell apart the shapes of one command on one collection.
  Keys are the schema most of the time and data some of the time — a key per day, a key per id — and the number of
  commands per request, which is what a regression changes, is counted either way.
- **The server as the target.** `Connection.address` is the IP the socket reached, and a replica set is three of them.

## Consequences

- A cloud older than 0.10.0 refuses a batch with a `mongodb` dependency. The cloud deploys with the merge, before any
  instrumentation that sends one is published.
- `observers` has no key for the switch, as for `mysql` (DT-97): whether it attached is in the debug log.
- Two shapes of `find` on one collection are one operation; their count per request is the same either way.
- The drivers before 6 — Mongoose 5 to 7 — are not observed. Their `command` answers through a callback, and their pool
  hands a waiting request its connection from the request that gave it back, so a wrapper there would record into the
  wrong request under load; a correct one would wrap the pool too. They are out of their maintainers' support, as the
  Prisma before 7 that `init` also names. `init` says it from the range a project declares.
- The next document database is this ADR's case, and its first question is the same: which method carries every
  command, and is it called in the context of the code that asked.
