# 0239 — SQLite is a dependency, and its statements are queries read as SQLite

Estado: aceptado · Fecha: 2026-10-30 · Amplía el ADR 0011 y el ADR 0086, y el protocolo a 0.11.0 · Alcance: público

## Context

SQLite is the database of most starters an agent writes and of the smaller backends: Drizzle on `@libsql/client`,
Prisma 7 on its better-sqlite3 adapter, better-sqlite3 by hand. The instrumentation did not see it, and `init` said so
(the stranger campaign of 2026-10-29: `w3cj/hono-open-api-starter`, Drizzle on libsql, every route
`nothing-observed`). The protocol had five kinds of dependency and the schema refuses a sixth.

Two drivers run nearly all of it, with one shape: better-sqlite3, and libsql, the fork `@libsql/client` opens a
`file:` URL with. A `Database` whose `prepare(sql)` gives a statement, a statement that runs with `run`, `get`, `all`
or `iterate`, and `exec(sql)` for text with no statement to keep. Every one of them is synchronous: it runs in the
context of the code that called it and returns when SQLite has finished. better-sqlite3 builds its addon in an install
script, which the workspace allows no test dependency (`allowBuilds`); the human allowed this one.

## Decision

**`sqlite` is a kind of dependency (protocol 0.11.0). The instrumentation wraps, under a `sqlite` switch, the methods
that run a statement on the class every statement of the driver shares, `exec`, and `prepare`; each statement a
request runs is an operation of kind `query`, normalised in a dialect of its own, `sqlite`.**

- **One dependency, no target**, as MongoDB: a database's path is the machine's and can hold a person's name, and the
  files of one process are one database to the question a profile asks.
- **Each run is counted, not each prepare.** Preparing once at start-up and running in every request is how these
  drivers are used. better-sqlite3's statements are its addon's class, reached in the module cache once the
  application has opened a database, so a statement prepared before the patch is wrapped and named by its `source`.
  libsql keeps no text of a statement: `prepare` is wrapped to remember it, and one prepared before the patch is
  counted against the dependency with no operation. `@libsql/client` prepares at every query, so all of its are named.
- **A run inside a run is not counted again.** libsql's `all` loops over its own `iterate`; it ran one statement.
- **The dialect:** a single quote opens a value; a double quote, a backtick and a bracket open a name, sanitised as
  ADR 0090 and 0238 say; a backslash escapes nothing; comments are `--` and `/* */`, and do not nest. A bracket is the
  first quote whose closer is another character, so the table of rules says the closer, and a closer found with
  nothing open is a character the scanner has no rule for. SQLite reads `"x"` as a string when no column is called x;
  better-sqlite3 is built without that, and a value written so is read as a name — what looks like a value in it
  still goes.
- **When:** as `pg` (ADR 0209): resolved at start-up from the application's root, from `@libsql/client` for the libsql
  it brings, and from `@prisma/adapter-better-sqlite3` for its better-sqlite3 (DT-92); loaded never; patched from the
  first request at which the driver is in the module cache. Both ship only CommonJS. Under Jest, the tests' copies are
  patched as they are required.

## Alternatives

- **`prepare` alone, wrapping each statement it returns.** It misses every statement prepared at start-up, which is
  the ordinary way to write better-sqlite3.
- **One `sqlite` switch for each driver.** They are one database to the person who reads the profile, and one switch
  is one thing to turn off.
- **The file as the target.** Its path is the machine's, and `:memory:` would be a target that says nothing.
- **Reading `"x"` as a value**, as MySQL's dialect does. Every ORM quotes every name with it, so the labels would lose
  every table and column for the sake of a spelling better-sqlite3 refuses.

## Consequences

- A cloud older than 0.11.0 refuses a batch with a `sqlite` dependency. The cloud deploys with the merge, before any
  instrumentation that sends one is published.
- `observers` has no key for the switch, as for `mysql` and `mongodb` (DT-97).
- `iterate` counts once when the loop starts; the time spent reading rows is the loop's, not the statement's.
- `sqlite3`, the callback driver, is not observed, and `init` names it. Neither is `@libsql/client` against a server,
  which is outgoing HTTP or a WebSocket; nor the libsql that `@prisma/adapter-libsql` reaches through its
  `@libsql/client`, two packages away from where a strict layout lets the start-up resolve it.
