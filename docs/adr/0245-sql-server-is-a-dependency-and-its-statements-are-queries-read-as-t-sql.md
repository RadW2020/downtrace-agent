# 0245 — SQL Server is a dependency, and its statements are queries read as T-SQL

Estado: aceptado · Fecha: 2026-10-31 · Amplía el ADR 0011, el ADR 0086 y el ADR 0239, y el protocolo a 0.13.0 · Alcance: público

## Context

SQL Server is the database of a large part of the backends that run on Azure and in companies: NestJS or Express with
TypeORM, Sequelize, Knex or Prisma on it. Every one of them reaches it through one driver, `tedious`: `mssql` wraps it
(TypeORM, Knex and Prisma 7's `@prisma/adapter-mssql` go through `mssql`), and Sequelize's `mssql` dialect calls it
itself. `tedious` is downloaded seven million times a week and `mssql` five; the instrumentation saw none of it, and
`init` named `mssql` among the packages it does not observe. The protocol had six kinds of dependency, and the schema
refuses a seventh.

Every request `tedious` sends — `execSql`, `execSqlBatch`, `callProcedure`, `prepare` and `execute`, a bulk load, the
begin, commit and rollback of a transaction — goes through one method, `Connection.prototype.makeRequest(request,
packetType, payload)`, and ends when the driver calls `request.callback(err, …)`, looked up on the request when it
ends. The text is the request's `sqlTextOrProcedure`. It is the same in `tedious` 16, 18, 19 and 20, which are nine
downloads in ten.

## Decision

**`mssql` is a kind of dependency (protocol 0.13.0), and a switch of `observers`. The instrumentation wraps, under a
`mssql` switch, `makeRequest`; each statement a request sends is an operation of kind `query`, normalised in a dialect
of its own, `mssql`.**

- **The target is the server and its port** (or its instance), what `mysql2`'s is: never the user, the password or the
  database.
- **The request that asked is taken in `makeRequest`, and the callback runs in it.** The driver ends a request on the
  connection's socket, whose context is whichever request opened it (gh-89). The application's callback is kept on the
  request, so a request run again wraps it and not the wrapper.
- **A transaction's round trips and a bulk load are calls with no operation**: they have no text.
- **What is not the route's is not counted.** The session's options the connection sends as it logs in do not go
  through `makeRequest`. `mssql`'s pool validates every connection it hands over with a `SELECT 1;` of its own,
  synchronously, from `_poolValidate`: that method is wrapped to say so, and what is sent while it runs is not counted.
  The pool binds it as it is built, at start-up, before the first request; so `mssql` is patched as the application
  loads it, which Node announces on its `module.require` channel, and not at the first request (a helper, `whenRequired`,
  which Prisma's adapter for MySQL over `mariadb`'s bundle uses too).
- **A prepared statement is the statement it was prepared with.** `mssql` prepares through `sp_prepare`, with the text,
  and executes through `sp_execute`, with only the handle the server gave back: the handle is remembered per connection,
  whether or not a request is asking (an application prepares at start-up), and an execution is named by its text.
- **The dialect:** a single quote opens a value, and no backslash escapes; a bracket opens a name, and `]]` is a bracket
  of the name, as Sequelize, Knex and Prisma write them; a double quote opens a **name**, as TypeORM writes them, and
  what looks like a value in one still goes (ADR 0090). It is a name with `QUOTED_IDENTIFIER` on, and `tedious` turns it
  on as it logs in, whatever the server's default. `@name` and `@0` are placeholders, as `:name` is everywhere, so a list of them collapses and
  every ORM's numbering is one label; `@@ROWCOUNT` is the server's and stays. A `$` is the money sign, read as
  Postgres reads it, so `$5.00` is a value. Comments nest. `#orders` is a temporary table and opens no comment.
- **When:** as `mysql2` (ADR 0209): resolved at start-up from the application's root and from `mssql`, which brings its
  own (DT-92), loaded never, patched from the first request at which the application has loaded it. Under Jest, the
  tests' copies of `tedious` and `mssql` are patched as they are required.

The money sign showed a gap of every dialect's: a placeholder `$1` stopped at its digits, and what was glued to it
travelled as a name (`$0x7365…` left `x7365…`). It now takes what is glued to it, as a number does.

## Alternatives

- **`mssql`'s diagnostics channels.** `mssql` 12 publishes some, but Sequelize and Knex's `mssql` client do not go
  through `mssql`, and an older `mssql` publishes nothing; `tedious` is under all of them.
- **Reading `"x"` as a value**, as MySQL's dialect does: the reading that swallows more, for a session that turned
  `QUOTED_IDENTIFIER` off by hand. It was the first version of this, and a TypeORM application's labels came back with
  no table and no column in them (`SELECT ?.? AS ?, ?.? AS ? FROM ? ?`): TypeORM quotes every name it writes so, and
  `tedious` reads them as names.
- **Leaving `@p0` as it is.** It is not a value, but a list of them would be one label per length of the list, and each
  ORM numbers its parameters differently.
- **Skipping `SELECT 1;` by its text.** An application's own health check is the same text.

## Consequences

- A cloud older than 0.13.0 refuses a batch with a `mssql` dependency. The cloud deploys with the merge, before any
  instrumentation that sends one is published.
- The wait for a connection is not measured: `mssql`'s pool (tarn) has no request to wrap.
- Prisma 4 to 6 on SQL Server goes through its engine, whose datasource `sqlserver` is not mapped to a dependency: not
  observed. Prisma 7 with `@prisma/adapter-mssql` goes through `mssql`, and is.
- On Node 20, which has no `module.require` channel, an `mssql` loaded after the instrumentation started keeps counting
  its pool's validation.
- The tests run the real `tedious` and `mssql` against a SQL Server of the tests' own (`test/support/mssql.ts`, a TDS
  server as small as the client lets it be), and against a real one when `MSSQL_URL` says where (Azure SQL Edge on the
  author's machine).
