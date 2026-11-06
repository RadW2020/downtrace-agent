# Databases

Part of the documentation of [`@downtrace/agent`](../README.md). What the instrumentation sends about the database work of each request, driver by driver, and where it finds your drivers.

## Database work per request

When your application uses `pg`, the instrumentation also counts the calls each request makes to it, how long they took in
total, the slowest one and how many failed, and reports that distribution per route. It also times how long each
request **waited for a connection** from the pool. That wait is not the database being slow, it is your application
having nowhere to run, and it is invisible in the query's own duration. A wait that ends without a connection — the
pool timed out, or the database refused — is counted too, on the same database as the connections that pool handed
over, or on the host and port of its connection string when it has handed none: a pool run dry is one dependency
saturated, not a nameless one. The connection string gives only its host and port, never its user, password or
database. It is what turns "this endpoint
got slower" into "this endpoint went from 12 queries per request to 65". **It never reads the query text or its
values**, only counts and durations.

A query counts for the request whose code ran it, and for no other. One that runs outside any request — a
migration at start-up, a scheduled job, a health check's poll, work a handler left for later — is in no route's
numbers, because no route ran it. A request answered before it reached the database — a gate that says «starting
up», a rate limiter's 429, a 401 for a missing session — carries no Postgres at all, because it made no call. So a
route with Postgres in one interval and none in the next has not lost its queries: its requests ran none inside
the request, which does not mean the database was idle. Checked against n8n with every statement logged by
Postgres: each request carried the queries the log shows for it, and the ones n8n answered without its database
carried none.

## Neon

When your application uses Neon's driver (`@neondatabase/serverless`: Drizzle's `drizzle-orm/neon-serverless`,
`@vercel/postgres`, Prisma's `@prisma/adapter-neon`), its `Pool` and `Client` are observed as `pg`'s, under the same
switch: they are `pg`'s, bundled into the package and speaking Postgres's protocol over a WebSocket. Per request, how
many queries, how long and how many failed, by the host and port of your connection string, and the wait for one of the
pool's connections. Its copy for `import` is imported by its file from the first request, and from the start under
`downtrace check`, as [postgres.js](#postgresjs)'s is; the copy `@vercel/postgres` nests under itself is found there.
Measured from 0.9 to 1.2. What it does not say:

- **`neon()` over HTTP** — and a `Pool` with `poolQueryViaFetch` — sends each query as a `fetch` to Neon's endpoint:
  it is a call to that host, with its time and status, and not a query.
- **A copy your bundler inlined** — Next.js keeps `pg` out of its bundles, and not Neon's driver unless you list it in
  `serverExternalPackages` — is not a module of its own, and is not found. On the Edge runtime nothing is.

## postgres.js

When your application uses postgres.js (`postgres`, the driver of Drizzle's `drizzle-orm/postgres-js` and of most
Supabase backends), its queries are observed under the same `pg` switch, as dependency `postgres`: per request, how
many, how long and how many failed, and each one an operation of the route by its text with `?` for every value —
postgres.js sends the values as parameters, and the text it reads is the one the driver built. A query outside a
request is in no route's numbers, as with `pg`. Run against a real Postgres, with the driver imported as ESM and
required as CommonJS, on postgres.js 3.4.9. What it does not say, and why:

- **Which server.** A postgres.js query does not know its connection, so every query is the dependency `postgres`
  with no host: a read replica and a primary reached through postgres.js are one dependency, not two, and a
  finding names no server.
- **The wait for a connection.** postgres.js queues a query that finds its connections busy inside the driver, and
  the wait is part of the query's time. A pool run dry shows as slower queries, not as a wait.
- **The first request, imported as ESM.** The ESM copy of the driver never enters the module cache the
  instrumentation reads, so it imports the driver's query module itself, the same file your `import "postgres"`
  loads, from the first request your server answers, on the next turn of the event loop. Queries that start before
  that import finishes, which in practice means the first request's, are not counted. Required as CommonJS it is
  patched before the first request's handler runs, as `pg` is. Under `downtrace check` the import starts at
  start-up, so a test file's first request counts.
- **A cursor read with `for await`** is not counted; one with a callback, and `forEach`, are.
- **Beside an error tracker** it was not verified. The instrumentation wraps `Query.prototype.handle`, where
  Sentry's own postgres.js integration also hooks, and it loads the query module only from the first request, after
  a tracker loaded with `--import` has registered its hooks.

## MySQL

When your application uses `mysql2`, the instrumentation does the same for MySQL, as a dependency of its own
(`mysql`): the queries each request makes, how long they took, how many failed, and how long the request waited
for a connection from a `mysql2` pool, apart from the query that followed it. TypeORM, Sequelize and knex — which
is what Strapi uses — reach MySQL through `mysql2`, so they are observed through it; nothing is asked of them. So does
MikroORM, whose `@mikro-orm/mysql` brings a `mysql2` of its own: that one is observed too, from where the package is.
So is an application that imports `mysql2/promise` alone, as Drizzle's guide writes it: from 3.24 that entry requires
the driver's classes and not `mysql2`'s own, and the instrumentation patches them from the connection's module, which
both entries load.
The target is the host and the port of the server (the socket path, for a socket), never the user, the password
or the database. Prepared statements (`execute`) count like queries.

**`mysql` (mysqljs), the driver `mysql2` was written to replace, is observed the same way**, because its API is the
one `mysql2` copied: its connection's `query`, its pool's `getConnection` and the wait on it, the text as the
application wrote it before the driver put the values into it. TypeORM loads `mysql` first when it is installed —
its documentation has long said to install it — and Knex's `mysql` client uses it. It loads each of its classes the
first time it is used, so the instrumentation requires its connection and its pool from its `lib` at the first
request, the modules your application's `mysql` loads. Run against 2.18.1, under Jest too.

**The query text is read as MySQL's, not as Postgres'.** In MySQL, without `ANSI_QUOTES`, a double quote opens a
*string*, where in Postgres it opens a name: `WHERE name = "ana"` has a value in it, and it is replaced like any
other (`WHERE name = ?`). A backtick opens a name, which stays: `` SELECT `name` FROM `users` `` travels as it is.
The rest of MySQL's lexical rules are the server's: a backslash escapes in a string, `#` and `-- ` open a comment,
`/* */` does not nest, and a `$` is a letter of a name. What the scanner cannot read with confidence is omitted
and not guessed: a `--` not followed by a blank, a comment opened with `/*!` (the server runs what is inside), a
block comment that opens another, a delimiter that never closes. Such a query travels as its hash and its class
(`select`, `insert`, …) and no text. A server in `ANSI_QUOTES` mode gets a poorer label — its double-quoted names
read as values — and nothing leaves.

What the instrumentation does with the driver, and what it gives up:

- **A query belongs to the request whose code ran it.** `mysql2` finishes a query on the connection's socket, in
  the async context of whichever request opened that connection, and its callback API is built on callbacks: the
  second query of a chain is asked from inside the first one's. So the context is taken when the application
  asks, the result is written into it, and the application's callback runs with it. That changes the one thing
  this instrumentation keeps in async storage and nothing of the application's own.
- **It wraps the methods that define `query`, `execute` and the pool's `getConnection`** — on the class `mysql2`
  defines them on, so a pool's connections are covered whichever way the version lays its classes out (up to 3.18 a
  pooled connection is not a `Connection`). Run against a MySQL 8.4 server, with every way of asking for a query, on
  2.3.3, 3.0.0, 3.2.0, 3.6.5, 3.9.8, 3.10.3, 3.11.5, 3.14.5, 3.19.1, 3.20.0 and 3.24.5. Arguments, results and
  errors pass through untouched, and if the wrapper itself fails the query still runs. It never asks a query for a
  result: `mysql2`'s commands throw when they are awaited.
- **The wait is the wait of `mysql2`'s own pool.** knex and Sequelize keep a pool of their own over plain
  connections, and a request that queues in it is not seen waiting. The wait of a MySQL pool travels with the
  dependency's aggregate, which is what a pool-saturation finding reads; it is **not** part of the wait that goes
  with a capture's requests, which is Postgres' (a finding over a MySQL pool gets no estimate of its impact, and
  says so).
- **A query run with listeners or as a stream** (`connection.query(sql).on("result", …)`) has no callback to
  settle: it is counted when it is issued, with no time and no failure, as a `pg` cursor is. Prepared statements
  made with `connection.prepare()` and run through the statement are not observed.
- **Beside an error tracker** this was not verified for `mysql2`, as it was for `pg` and `ioredis`
  ([below](errors.md#beside-your-error-tracker)): the mechanism is the same — it resolves the driver and loads nothing — but
  nobody has run the pair.

**Through `mariadb`** — the connector MariaDB publishes, which Prisma's adapter for MySQL and MariaDB
(`@prisma/adapter-mariadb`, the one Prisma 7 needs for them) and Sequelize's `mariadb` dialect query through — it is
the same: the same dependency, `mysql`, with the same target, the text read as MySQL's, the wait on its pool, and a
callback that runs in the request that asked. The copy `@prisma/adapter-mariadb` brings is observed from where the
adapter is. Every way the driver runs a statement goes through its connection's `query`, `prepareExecute` and `batch`,
and the callback API's own `query`; those are what it wraps, from 3.0.1. Run against MySQL 8.4 and MariaDB 11.4, with
prepared statements, batches, errors and transactions, on 3.4.7 and 3.5.4, and its queries on 3.0.2, 3.1.2 and 3.3.2.

- **Up to 3.4 the driver is CommonJS, and from 3.5 its modules are ES modules.** 3.5's are imported by their URL, the
  modules your application's `import` loads, from the first request — from the start under `downtrace check` —, as
  postgres.js's are: a query that starts before that import resolves is not counted.
- **What `require("mariadb")` loads from 3.5.3 on is one bundle, `dist/promise.cjs`, which exports none of the
  driver's classes**, and is not observed; `DOWNTRACE_DEBUG=1` says so at the first request. An application compiled
  to CommonJS — NestJS's, for one — with Prisma 7.10's adapter, which pins 3.5.4, has its queries go there, and they
  are observed one floor up, at the adapter: as it loads, which Node announces on its `module.require` channel (on Node
  22 and later; on Node 20, only an adapter loaded before the instrumentation started), and under Jest in its
  registry. Every query Prisma sends is a query of the route, with its time and its failure; the dependency is `mysql`
  with no target, because the bundle keeps the server to itself, and the wait for a connection and the `BEGIN` and
  `COMMIT` the adapter sends on its own are not seen. Prisma 7.0 to 7.9 pin 3.4.5, which is observed at the driver
  however it is loaded. Sequelize or code of your own on the bundle stays unobserved.
- **What the connection runs while it opens** — `SET NAMES`, the session's variables — is not counted: a pool opens a
  connection inside the request that found none free, and those statements are the driver's.
- **`queryStream`**, and `execute` and `batch` before 3.4, which return a promise of their own, are not observed. A
  callback query with no callback is counted when it is issued, with no time and no failure.

## SQL Server

When your application reaches SQL Server, the instrumentation does the same, as a dependency of its own (`mssql`):
the statements each request sends, how long they took and how many failed. Every way there goes through one driver,
`tedious`: `mssql` wraps it, and TypeORM, Knex and Prisma 7's `@prisma/adapter-mssql` go through `mssql`; Sequelize's
`mssql` dialect calls `tedious` itself. Nothing is asked of any of them. The target is the server and its port (or
its instance), never the user, the password or the database. Run against `tedious` 20 and `mssql` 12, against a
server of the tests' own and against Azure SQL Edge, with parameterised queries, prepared statements, a stored
procedure, a server's error and a transaction; `tedious` 16 to 19 have the same method.

**The text is read as T-SQL.** A single quote opens a value, and a backslash escapes nothing in it; a bracket opens a
name — `[dbo].[users]`, `[Order Items]` —, and `]]` inside one is a bracket of the name. A double quote opens a name
too, as TypeORM writes them (`"User"."email"`): `tedious` turns `QUOTED_IDENTIFIER` on as it logs in. A name that looks
like a value — an email, a number — goes as `?`, as in Postgres. `@p0`, `@0`, `@P1` and `@id` are placeholders, so a list of them is one label however long it is
and whichever ORM numbered it, and `@@ROWCOUNT` stays. `N'…'`, `0x…` and `$5.00` are values. Comments nest. `#orders`
is a temporary table.

What the instrumentation does with the driver, and what it gives up:

- **It wraps `Connection.prototype.makeRequest`**, which every request `tedious` sends goes through, and the
  `callback` of the request, which runs in the request that asked: the driver ends a statement on the connection's
  socket, in the context of whichever request opened it. Arguments, results and errors pass through untouched.
- **A prepared statement is named by its text.** `mssql` prepares once with the text and executes with a handle; the
  handle is remembered for its connection, also when it was prepared at start-up.
- **A stored procedure is named by its name** (`dbo.refresh`); a transaction's begin, commit and rollback, and a bulk
  load, are calls with no operation.
- **What is not your route's is not counted:** the options the connection sets as it logs in, and the `SELECT 1;` with
  which `mssql`'s pool validates a connection before it hands it over. That validation is skipped by patching `mssql`
  as your application loads it, from Node 22; on Node 20, an `mssql` loaded after the instrumentation started keeps
  counting it.
- **The wait for a connection is not measured:** `mssql`'s pool has no request to wrap.
- **Prisma 4 to 6 on SQL Server** goes through its own engine, and is observed through its client, by action and model
  ([Prisma](#prisma), switch `prisma`); Prisma 7, which needs `@prisma/adapter-mssql`, through `mssql`, statement by
  statement.

## SQLite

When your application opens a SQLite database through `better-sqlite3`, or through `libsql` — which is what
`@libsql/client` opens a `file:` URL with, and so Drizzle and Prisma 7's adapters on either, and MikroORM's packages for
SQLite, whose driver they bring — the instrumentation
observes it as a dependency of its own (`sqlite`): the statements each request runs, how long they took and how many
failed. Each statement is an operation of kind `query`, normalised as SQLite reads it: a single quote delimits a
value; a double quote, a backtick and a bracket delimit a name, kept while nothing in it looks like a value; and a
backslash escapes nothing. `select * from "users" where "email" = 'ana@example.com'` is
`select * from "users" where "email" = ?`.

What the instrumentation does with the driver, and what it gives up:

- **It wraps the methods that run a statement** — `run`, `get`, `all`, `iterate` — on the class every statement of the
  driver shares, and `exec`, and `prepare` to learn each statement's text where libsql keeps none. A statement your
  application prepares once at start-up and runs in every request is counted at each run. It is put in place from the
  first request, resolved and not loaded at start-up, as for `pg`, on the driver your application loads and on the
  libsql `@libsql/client` brings. Results and errors pass through untouched. Run with better-sqlite3 12, libsql 0.5
  and `@libsql/client` 0.18, on `:memory:`.
- **One dependency, with no target.** A database file's path is your machine's; every file is one `sqlite`.
- **Preparing is not running**, and is not counted. `iterate` counts the statement once, when the loop starts; the time
  the loop spends reading rows is the loop's.
- **A libsql statement prepared before the instrumentation was in place** — at start-up, before the first request —
  is counted against the dependency and has no label: libsql keeps no text of a statement. better-sqlite3 keeps it,
  and those are named like any other. `@libsql/client` prepares at every query, so all of its are named.
- **`@libsql/client` against a server** — Turso, `libsql://`, `http://` — is outgoing HTTP or a WebSocket, not this.
- **`sqlite3`**, the callback driver Knex and Sequelize open SQLite with, is observed too, 5 and 6: each statement its
  `Statement` runs — which every method of its `Database` makes and runs — is counted from the call, in the request
  that made it, to the callback the driver answers through, whose arguments and `this` pass untouched; a statement that
  does not compile is counted as a failed one. A statement run with no callback is not counted: nothing says when it
  ends, and giving it one would change where its errors go. `each` is counted when it has its completion callback.
- `observers` in the batch says `on` when a driver was found; when none was, it says nothing, as for an application
  that does not use it.

## MongoDB

When your application uses MongoDB through its official driver, `mongodb` 6 or 7 — and so through Mongoose 8 and 9,
which send every command through it — the instrumentation observes it as a dependency of its own (`mongodb`): the
commands each request sends, how long they took and how many failed. Each command is an operation of kind `query`,
named by two words, the command and the collection: `find users`, `insert orders`, `aggregate events`, `getMore
orders`. **Never the filter, the documents, the pipeline or the update**, which hold your data; a collection whose name
looks like a value (`tenant_8f3a9c2e…`, a number) is `?`, so a collection per customer is one operation and its name
stays on your server. Two shapes of one command on one collection — a `find` by email and one by id — are one
operation, and a request that sends one more of them counts one more. A command the server refused, and an insert a
unique index refused, are failures.

What the instrumentation does with the driver, and what it gives up:

- **It wraps one method, `Connection.prototype.command`**, which every command the driver sends goes through, on the
  driver your application loads and on the one Mongoose or `@mikro-orm/mongodb` brings when that is another. It is put in place from the
  first request, resolved and not loaded at start-up, as for `pg`. Arguments, results and errors pass through
  untouched, and if the wrapper itself fails the command still runs. Run with the driver against the tests' own server
  on 6.21 and 7.7, with Mongoose 9, and against MongoDB 7.
- **One dependency, with no target.** A replica set's members — the primary, the secondaries a read goes to — are one
  database to your application.
- **The driver's own conversation is not a request's**: the handshake and the authentication of a new connection, and
  ending the sessions, are not counted, and no command outside a request is.
- **The wait for a connection** from the driver's pool is before the command, and is part of no command's time.
- **Mongoose 5 to 7, on the drivers 3 to 5, are not observed.** Those drivers answer through callbacks, and their pool
  hands a waiting request its connection from the request that gave it back: what a wrapper recorded would not be
  known to be the request's. `init` says it, from the range your `package.json` declares.
- `observers` in the batch says `on` when a driver was found; when none was, it says nothing, as for an application
  that does not use it.

## Prisma

Prisma is observed two ways, by the engine that runs its queries: Prisma 7, and 6.16 or later with
`engineType = "client"`, query through a driver adapter, and are seen through that driver, as SQL; before 7, on Prisma's
own engine, a client `prisma-client-js` generated is seen through the client itself, as Prisma's operations.
Measured version by version, with this instrumentation loaded through `--import`:

| Your Prisma | Its queries go | Observed |
|---|---|---|
| 7.x, with `@prisma/adapter-pg`, `@prisma/adapter-better-sqlite3` or `@prisma/adapter-mariadb` | through `pg`, `better-sqlite3` or `mariadb`: 7 has no engine of its own and requires an adapter | **Yes**, as the driver's SQL (`pg`, `sqlite`, `mysql`); with `@prisma/adapter-mariadb` 7.10 or later in an application compiled to CommonJS, at the adapter, with no server named ([MySQL](#mysql)) |
| 6.16 and later with `engineType = "client"` in the schema's generator (6.7 to 6.15: the `queryCompiler` preview), with either adapter | through the driver, as 7 does | **Yes**, the same |
| 3.15 to 6.x on its default engine, with no adapter, from the `prisma-client-js` generator: what Prisma does before 7 unless told otherwise | from Prisma's query engine, which speaks to the database itself | **Yes**, as Prisma's operations (`prisma`), measured on 3.15.2, 4.0.0, 4.16.2, 5.22.0 and 6.19.3 |
| 6.x on its default engine from the `prisma-client` generator, what `prisma init` writes in 6.19 | the same, from a client that imports Prisma's runtime as an ES module | **No**: see below |
| 5.x, and 6.x on its default engine, with an adapter | from the query engine, which calls the adapter, and so its driver, from a thread of its own | **No** |
| Any version with another adapter (Neon, PlanetScale, …) | through that adapter's own driver | **No**: it was not looked at |

**Through the driver**, nothing is asked of you: a Prisma query is a query of the route that ran it, with its time and its
errors, and its fingerprint in the route's profile, like any `pg` query. The queries of `prisma.$transaction` carry the
`BEGIN` and the `COMMIT` that Prisma sends, because they are queries. Prisma sends its values as parameters, so what a
`findMany({ where: { name } })` is called is `… WHERE "public"."User"."name" = ? OFFSET ?`; SQL that you write yourself with
a value in it (`$queryRawUnsafe`) is normalised like any other, and the value does not leave. Prisma merges calls to
`findUnique` of the same shape made in the same tick into one query (`WHERE "id" IN (…)`), and that query is counted
once, for the request whose call came first: measured on 7.10.0, four requests that asked for the same row in one tick
made one query. To be observed this way: Prisma 7, or on 6.16 or later `engineType = "client"` in the generator block of
the schema, and the adapter. No tracing and no OpenTelemetry are involved:

```ts
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
```

**Through the client**, on Prisma's own engine, nothing is asked of you either. Every operation of a generated client goes
through one method of its class, and the instrumentation wraps it (switch `prisma`):

- **Each operation is one query, of the database the datasource is** — `postgresql` and `cockroachdb` are Postgres,
  `sqlserver` is SQL Server (`mssql`), and `mysql`, `sqlite` and `mongodb` their own — **named by its action and its
  model**: `findMany Post`, `create User`,
  `count Order`. Never its arguments. A raw query is named by its SQL, normalised as that database reads it:
  `` prisma.$queryRaw`select "id" from "User" where "email" = ${email}` `` is `select "id" from "User" where "email" = ?`.
- **It counts what your code asked for.** An `include` is one operation, however many statements the engine runs for
  it; the `findUnique`s Prisma batches in one tick are each one, as you wrote them; every operation of a
  `$transaction`, of an interactive one, and of a client `$extends` made is counted; a middleware that answers without
  the engine is not. A loop that runs a `findMany` per item is the N+1 `check` is for, and it is seen.
- **Where the client is found.** In the module cache, nothing loaded at start-up, as for `pg`: the client generated
  into `node_modules/.prisma/client`, which every Prisma 3 to 5 project has, and one generated into a directory of your
  own (`output = "../generated/prisma"`, what Prisma 6 asks for), with the copy of Prisma's runtime Prisma puts beside
  it, as long as it is loaded as CommonJS. Since that directory is yours to name, the whole cache is looked at, at the
  1st, 2nd, 4th… request up to the 1024th, and not again once a client is found: a client your application loads
  after that is not seen. Under Jest, the copy of a module whose name has `prisma` in it — `@prisma/client`,
  `../generated/prisma`. Under `downtrace check`, also as Prisma's runtime is loaded: what reaches a client a test
  runner loads outside Node's module cache, as Vitest does one generated into your project's directory, whose runtime
  Node still loads. Not seen: a client the `prisma-client` generator wrote — what `prisma init` writes in 6.19 —, which
  imports Prisma's runtime as an ES module nothing can reach into (on Prisma 7 it goes through a driver adapter, and is
  seen through the driver); one a bundler inlined; and, outside `check`, one a runner loads itself.
- **Not counted twice.** A client given a driver adapter is left alone: its SQL is the driver's to count.
- `observers` in the batch says `prisma: on` when `@prisma/client` resolves from your application, and nothing when it
  does not.

How to tell which row you are in: with `DOWNTRACE_INSPECT`, a route whose Prisma queries are seen has a `postgres` (or
`mysql`, `sqlite`, `mongodb`) dependency. A route that queries through Prisma and has none is in one of the **No** rows,
and is not a route that makes no queries.

**Why the engine's queries are not seen through an adapter.** With an adapter, the engine calls it from a thread of its own, so the query
reaches `pg` carrying none of the request's async context: `pg` sees every query, outside any request, and a query
outside a request counts for no route. The instrumentation counts a query for the request whose code ran it and never
guesses which one that was. The versions that run their queries in JavaScript run them in the context of the call that
asked: with four concurrent requests, every query came to the request that made it. Without an adapter, there is nothing to
see through `pg` at all.

**What could be seen, and is not asked for.** Prisma's engine can report each query as a trace span, and what it looks for
in order to do it is an object on `globalThis`, so it can be read without loading OpenTelemetry into your application. The
instrumentation does not switch it on, because the engine only produces those spans when asked to, and asking has a price
that was measured against the same Postgres on the same machine: a query went from 0.38 ms to 0.46 ms, about a fifth more,
and the process used about 15 points more CPU while queries ran back to back; and Prisma appends a comment with the trace's
identity to every statement it sends. A request that runs twelve queries would spend on that the millisecond that is the
whole budget (see [Guarantees](../README.md#guarantees)). On 5.x it also needs `previewFeatures = ["tracing"]` in your schema. It is a decision
this README does not take for you.

**The `pg` the adapter uses.** From 6.11, `@prisma/adapter-pg` has `pg` as a dependency of its own and not as a peer (in 5.x and up to 6.10 it was one), and the
copy it queries through is not always yours: with pnpm, an application that lists the adapter and not `pg` has none at its
root, and with npm a `pg` of yours that the adapter's version range does not take is a second copy beside it. So the
instrumentation also resolves the `pg` that `@prisma/adapter-pg` resolves, without loading it, and patches it when the
application has: a query is counted by the copy it went through, once.

## On Node 18

The instrumentation runs from Node 18.19.0 ([requirements](../README.md#requirements)), and there it observes what it
observes on Node 24, for every driver version that itself runs on 18.19. Each version below was run on Node 18.19.0
and on Node 24, imported and required where it can be both, with a query that succeeds and one that fails, against
the packed package, the MySQL drivers against MariaDB 11.4 and SQL Server's against Azure SQL Edge: both Nodes wrote
the same dependency, target, queries and error. A newer version asks for the Node its `package.json` declares.

| Driver | Run on Node 18.19.0 | Newer versions |
|---|---|---|
| `pg` | 8.23.1 | |
| postgres.js (`postgres`) | 3.4.9 | 4 declares Node 18, and is not observed, on any Node |
| Neon's driver (`@neondatabase/serverless`) | 0.10.4 and 1.2.0, given a global `crypto` (below) | 1.0 and later declare Node 19 |
| Prisma | 3.15.2, 4.16.2, 5.22.0 and 6.19.3 on its own engine; 6.19.3 with `@prisma/adapter-pg` | 7 needs Node 20.19, 22.12 or 24 |
| `mysql2` | 3.24.6 | |
| `mysql` (mysqljs) | 2.18.1 | |
| `mariadb` | 3.4.8 | 3.5.1 and 3.5.2 declare Node 18 and run there only imported, and from 18.20: their modules are ES modules, which Node 18 cannot require, and they import with import attributes, which 18.19 does not read. 3.5.3 and later declare Node 20 |
| `better-sqlite3` | 11.10.0 | 12 declares Node 20, 22, 23 or 24; 13 declares Node 22 |
| `libsql` | 0.5.29 | |
| `@libsql/client` | 0.18.0, on a file | |
| `sqlite3` | 5.1.7 | 6 declares Node 20.17 |
| `tedious` | 19.2.2 | 20 declares Node 22 |
| `mssql` | 12.7.14, over `tedious` 19.2.2, which it takes as it takes 20 | |
| `mongodb` | 6.22.0 | 7 declares Node 20.19 |
| Mongoose | 8.24.8 | 9 declares Node 20.19 |
| `ioredis` | 5.11.1 | 6 declares Node 20 |
| `redis` (node-redis) | 5.12.1 | 6 declares Node 20 |

One difference: on Node 18, as on Node 20, the `SELECT 1;` with which `mssql`'s pool checks a connection before it hands it over is
one more query of the route that took it ([SQL Server](#sql-server)).

**Neon's driver does not run on Node 18 by itself**, in either version: it signs in with `crypto.getRandomValues` from
the global `crypto`, which Node has without a flag from 19, and on 18 the process ends at the first query. Set it
before the driver loads — under ES modules, from a module of its own imported first, because imports run before the
code that follows them:

```js
// webcrypto.cjs
globalThis.crypto ??= require("node:crypto").webcrypto;
```

Before Node 22 there is no global `WebSocket` either, and the driver takes the one you give it,
`neonConfig.webSocketConstructor = ws`, as its own documentation says.

## Where the drivers are found

`pg`, `postgres`, `mysql2`, `mysql`, `mariadb`, `tedious`, `better-sqlite3`, `libsql`, `sqlite3`, `mongodb`, `@prisma/client` and Express are resolved from your application's entry where Node runs it, so they are the ones your
application loads; and so is the `pg` that `@prisma/adapter-pg` brings, from where that adapter is, the `mariadb` that `@prisma/adapter-mariadb` brings, the `tedious` that `mssql` brings, the `better-sqlite3` that `@prisma/adapter-better-sqlite3` brings, the `libsql` that `@libsql/client` brings, the `mongodb` Mongoose brings, from where Mongoose is, and the driver each of MikroORM's packages for a database brings, from where that package is. Started through a symlinked binary — `npm i -g`, a `/usr/local/bin/<app>` — that is the file
the link points to, as it is for Node, and the link itself when the process runs with `--preserve-symlinks-main`
(on the command line or in `NODE_OPTIONS`), as it is for Node too. Started with `node .` or `node <directory>`,
they resolve from inside that directory, where Node finds your `main`: from the directory, not from the `main`
itself, which differs only for a `main` that is a symlink out of it or that has a `node_modules` of its own
between it and the directory. Under `downtrace check`, whose processes have your test runner as their entry, they
are resolved from the directory the tests run in as well, and every copy either finds is observed: a runner your
package manager keeps where nothing of your project resolves — pnpm's global virtual store, a workspace without
hoisting — would otherwise leave your database unseen and your mounted Express routes and Hono routes unnamed. A `pg`
that cannot be resolved from there is reported as `unavailable` in the
batch's observers, which `DOWNTRACE_INSPECT` shows you. `mysql`, `mssql`, `sqlite`, `mongodb` and `prisma` are reported `on` when found,
and left out when not: with every switch on by default, an `unavailable` for each database an application does not use
would hide the one it does. `DOWNTRACE_DEBUG=1` says at start-up which drivers were not found. `downtrace check` reads
the `package.json` where it runs, and adds a note for each observer, `pg` included, that found no driver your project
depends on — `mysql2` declared and `mysql` left out —, and none for a database it does not depend on.
