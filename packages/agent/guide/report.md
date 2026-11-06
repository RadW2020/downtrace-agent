# Read what `DOWNTRACE_INSPECT` wrote: `downtrace report` and `downtrace compare`

Part of the documentation of [`@downtrace/agent`](../README.md).

```sh
DOWNTRACE_INSPECT=./run.jsonl node --import @downtrace/agent/register app.js   # use it, then stop it
npx downtrace report run.jsonl
npx downtrace compare base.jsonl run.jsonl
```

[`downtrace check`](check.md) needs tests that reach your application over HTTP, with its database behind it. A project whose tests mock their repositories has none, and `check` sees no operation at all. These two commands need no tests and no account: they read the file `DOWNTRACE_INSPECT` writes — one JSON line per batch, exactly what the instrumentation would send — however you made your application serve requests while it was writing. Nothing leaves the machine, and neither command makes a network request.

## Recording a file

Set `DOWNTRACE_INSPECT` to a path and start the application as you always do, with the instrumentation loaded. Use it — by hand, with a script, with an end-to-end suite — and stop it. Three things about what lands in the file:

- **When it is written.** A process writes what it counted every ten seconds (`DOWNTRACE_INTERVAL_MS`), what each route ran when its profile window closes, every minute (`DOWNTRACE_PROFILE_MS`), and all it holds as it ends. Read the file after the application stopped, or the last minute's requests are counted and what they ran is not in it yet: the report says how many such requests there were.
- **Every process writes into the same file**, a cluster's workers and a restart included, and both commands add them up, counting a batch written twice once.
- **The file grows and nothing rotates it.** Start from an empty one for a report of one session, and record each side of a comparison in a file of its own.

`DOWNTRACE_INSPECT=stderr` works too, if you keep standard error in a file: the lines that are not batches — your application's own — are left out and named.

## `downtrace report <file>`

For each route, the most queries per request first:

```
downtrace report: run.jsonl
  6 requests on 3 routes, 1 process wrote 1 batch

By queries per request, most first (3)
  GET /orders   2 requests  ·  21 queries per request on average, median 21 to 50
    repeated   select * from "users" where "id" = ?  [query 81ca38dfd955b40d]  20 per request
    slowest    select * from "orders"  [query a20daf84175a003a]  0.01 ms per execution, 1 per request
    slowest    select * from "users" where "id" = ?  [query 81ca38dfd955b40d]  under 0.01 ms per execution, 20 per request
    request duration: 0.41 ms on average
  GET /users/:id   3 requests  ·  4 queries per request on average, median 3 to 5
    repeated   select * from "users" where "id" = ?  [query 81ca38dfd955b40d]  4 per request
    slowest    select * from "users" where "id" = ?  [query 81ca38dfd955b40d]  0.01 ms per execution, 4 per request
    request duration: 3.7 ms on average
  GET /health   1 request  ·  0 queries per request on average, median 0
    request duration: 0.21 ms on average
```

- **Requests**: every request the route served.
- **Queries per request, on average**: its queries' executions divided by its requests that a profile window covers, as `check` divides them. The queries are a database's — Postgres, MySQL, SQL Server, SQLite, MongoDB, Prisma's operations — and not the outgoing calls or the Redis commands.
- **The median**: the bucket the middle request falls in, from the counts each interval carries: how many requests ran 0 queries, 1, 2, 3 to 5, 6 to 10, 11 to 20, 21 to 50, or more than 50. A bucket and not a number, because the instrumentation counts requests by bucket and keeps no request's own count. With the average, it tells one request that runs fifty queries from fifty requests that run one. When a route's requests reached more than one database in an interval, each database is counted on its own and how many queries one request ran in all is not in the file: the median is said to be not known.
- **Repeated**: the queries, outgoing calls and Redis commands a request ran more than once on average, the most repeated first. More than once on average means at least one request ran it more than once: a query that runs once per row of a list is the N+1 to read first.
- **Slowest**: the three that took longest per execution, with how many times a request ran them.
- **Request duration**: the mean time of a request.

Nothing in it is a verdict: one file has nothing to be compared with. A route no profile window covered says its queries are not known, and comes last.

## `downtrace compare <base file> <change file>`

`check`'s verdict over two such files, recorded however the project can: its end-to-end suite run on the base branch and then on yours, the application used by hand before and after a change. `check` then does not have to run your tests twice in a checkout of its own, which in some monorepos means a full install and a build of the base.

The verdict comes from the same code as `check`'s, and says the same: each route is **worse**, **unchanged** or **not evaluated**, by composition and never by latency, with the same thresholds, the same exceptions — [a setting of the session](check.md#what-it-answers-and-what-it-does-not), a call to this machine on any port, a bucket of requests — and the same [reasons a route is not evaluated](check.md#why-a-route-was-not-evaluated). The same file on both sides changes no route. What a file cannot tell is the routes nobody called: `check` reads them off the application's router as it runs, and a file has only the routes that served a request, so a route neither side called is not named.

The exit status is `check`'s: **0** no route got worse, **1** at least one did, **2** no comparison could be made — a file could not be read, a side counted no request, or no route could be evaluated.

## What is read, and what is refused

Each line that is a batch is read. A line that is not one — the line a process was writing when it was ended, a line of your application's own — is left out, named by its number (`left out: line 3`) and counted. A file is refused, with exit status 2 and no report, when:

| Code | Why |
|---|---|
| `unreadable-file` | The file could not be opened: there is no such file, it is a directory, or it may not be read. |
| `not-inspection-file` | No line of it is a batch: it is empty, or it is not a file `DOWNTRACE_INSPECT` wrote. The report names the first line that fails, and why: it is not JSON, or it is JSON that says no protocol. |
| `unreadable-protocol` | A batch says a protocol this version cannot read: anything but a minor of protocol 0, whose fields are only ever added. The report names its line and stops there, because half a file read would undercount every route without a word. Read it with the version of `@downtrace/agent` that wrote it, or a later one. |
| `no-requests` | Its batches counted no request: no route answered while it was written, or it was read before a process wrote what it counted. |
| `nothing-evaluated` | `compare` only: no route could be evaluated, so nothing is said about any of them, as `check` says it. |

## What they hand back

For a person, the text above. For a coding agent, `--json`, with the same content.

`downtrace report --json` prints one object, `schema: "downtrace-report/1"`, with `status` (`reported` or `failed`), `file` (what was read of it: the `file` as you named it, `processes`, `batches`, `requests`, `routes`, `profileWindows`, `malformed` — the lines and entries that could not be read — `unreadLines`, the first twenty of their line numbers, and `observers`), `routes`, most queries per request first, `failure` and `notes`. Each route has its `id` (`GET /orders`), `method`, `route`, `requests`, `profiledRequests`, `queriesPerRequest` (`mean`, `median` as `{ from, to }` with `to` null for «more than», and `severalDatabases`), `repeated` and `slowest` — each operation with its `id`, `kind`, `hash`, `label`, `perRequest`, `executions` and `msPerExecution` — and `meanRequestMs`.

`downtrace compare --json` prints one object, `schema: "downtrace-compare/1"`, with `status` (`compared` or `failed`), `summary`, `routes` exactly as [`check` hands them back](check.md#what-it-hands-back), `base` and `change` (what was read of each file, as `file` above), `failure` and `notes`. A `failure` of either command has its `code`, the `message`, the `advice`, and the `line` of the file it is about, or null; `compare`'s also has the `side` it is about.
