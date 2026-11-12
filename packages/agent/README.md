# @downtrace/agent

**Downtrace tells you when a change breaks the performance of your Node.js backend: before you deploy, which route now runs a query once per row or one more outgoing call per request; after you deploy, which route got slower or started failing, and what changed.** This is its **instrumentation**: it observes your application from the inside, aggregates locally per route and 10-second interval, and, in production, ships compact batches to the Downtrace cloud — never in your request path, never able to throw into your code, with bounded memory.

It observes these, each of which can be switched off with `DOWNTRACE_INSTRUMENT`:

| Name | What it sees |
|---|---|
| `http` | Incoming requests by route, and outgoing calls by host, with status and duration |
| `pg` | Postgres queries per request, their time and errors, and how long a request waited for a connection; Prisma 7's too, through `pg`; Neon's driver's over its WebSocket; and postgres.js's, with no wait and no server |
| `mysql` | MySQL and MariaDB queries per request through `mysql2`, `mysql` and `mariadb`, their time and errors, and how long a request waited for a connection |
| `mssql` | SQL Server statements per request through `tedious`, and so through `mssql`, TypeORM, Knex, Sequelize and Prisma's adapter, by server, their time and errors |
| `sqlite` | SQLite statements per request through `better-sqlite3`, `libsql` (and so `@libsql/client` on a file, and the ORMs that run on either) or `sqlite3` (Knex's and Sequelize's), their time and errors |
| `mongodb` | MongoDB commands per request through its official driver, and so through Mongoose, by command and collection, their time and errors |
| `prisma` | Prisma's operations per request from 3.15 to 6, through its own engine, by action and model (`findMany Post`), under the database they reach, their time and errors |
| `redis` | Redis commands per request, by server, through `ioredis` or `redis` (node-redis 5.12 and later) |
| `runtime` | Event loop delay, GC pauses, heap, RSS and requests in flight |

It watches only the process it is loaded into: one process, one service. In this documentation the **instrumentation** is this library and a **coding agent** is whoever operates Downtrace; the package keeps its older name.

## Before you deploy, with no account

Your tests pass, and a change made a route run a query once per row. `downtrace check` runs your tests on `HEAD` and on your working tree, and tells you, route by route, what each request now runs that it did not:

```sh
npm install --save-dev @downtrace/agent
npx downtrace init     # finds your test command, writes downtrace.json; asks nothing
npx downtrace check    # exit 0: no route got worse · 1: one did · 2: no comparison could be made
```

```
Worse (1)
  GET /orders   3 requests in the base, 3 in the change
    appeared   SELECT name FROM users WHERE id = ?  [query 0ee1294e0ade7fb8]  0 -> 50 per request
    appeared   SELECT id, total, user_id FROM orders ORDER BY id  [query fb36696aebd98a68]  0 -> 1 per request
    gone       SELECT o.id, o.total, u.name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id  [query 0ad9139c76ae524a]  1 -> 0 per request
    request duration, shown and not judged: 1 ms -> 14.82 ms
```

Nothing leaves the machine: the runs get no token and no URL. Durations are shown and never judged, since a test run is not production; the verdict comes from what each request ran — queries, outgoing calls, Redis commands — and how many times. A route the tests did not reach is said to be not evaluated, by name, and never unchanged. A coding agent reads the same result with `--json`.

No tests that reach your application over HTTP? Start it with `DOWNTRACE_INSPECT`, use it, stop it, and read what each route ran, the most queries per request first:

```sh
DOWNTRACE_INSPECT=./run.jsonl node --import @downtrace/agent/register app.js
npx downtrace report run.jsonl                # each route: requests, queries per request, what repeats, the slowest
npx downtrace compare base.jsonl run.jsonl    # check's verdict over two such files, recorded however you can
```

```
  GET /orders   2 requests  ·  21 queries per request on average, median 21 to 50
    repeated   select * from "users" where "id" = ?  [query 81ca38dfd955b40d]  20 per request
```

The whole of it: [`downtrace init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md), which configures a project asking nothing and making no network request, [`downtrace check`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md), and [`downtrace report` and `downtrace compare`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/report.md). Production, with the cloud, is experimental and has [a page of its own](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/production.md).

## Documentation

The reference pages live beside this README, in `guide/` of the package:

- `downtrace` [`init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md), [`check`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md) and [`report`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/report.md)
- [In production, with the cloud](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/production.md) (experimental): install, configuration, the ingestion token, what leaves your server, errors, guarantees and requirements

## Changelog

See [`CHANGELOG.md`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/CHANGELOG.md).

## Source

This package is developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). Issues are welcome there. MIT.
