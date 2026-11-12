# @downtrace/agent

> Your coding agent just introduced an N+1. `downtrace check` catches it before you push.

`downtrace check` runs your tests twice, on `HEAD` and on your working tree, and names the routes that got worse: a query that now runs once per row, a query or an outgoing call that was not there. It needs no account, and nothing leaves your machine.

## Three commands

```sh
npm install --save-dev @downtrace/agent
npx downtrace init     # finds your test command, writes downtrace.json; asks nothing
npx downtrace check    # exit 0: no route got worse · 1: one did · 2: no comparison could be made
```

```
1 of 1 routes evaluated: 1 worse, 0 unchanged.

Worse (1)
  GET /posts   1 request in the base, 1 in the change
    appeared   select name from authors where id = ?  [query ca05af865ef461a0]  0 -> 5 per request
               ran at src/app.js:9
    request duration, shown and not judged: 3.16 ms -> 7.27 ms
```

The verdict comes from what each request ran (queries, outgoing calls, Redis commands) and how many times. Durations are shown and never judged: a test run is not production. A query that only took the place of another is not worse, so the join that fixes the N+1 passes. A route your tests did not reach is said to be not evaluated, by name, and never unchanged.

It needs tests that reach your application over HTTP, with its database behind it. The whole of it: [`check`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md) and [`init`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/init.md).

## With your coding agent

Paste this into your `AGENTS.md` or `CLAUDE.md`:

```md
Before pushing, run `npx downtrace check`. If it exits 1, fix the routes it lists or explain why the change is intended.
```

The output names the route, the query and the line of yours that ran it, which is what a coding agent needs to fix it. With `--json` it is one object, whose contract is a [JSON Schema](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/schema/check.schema.json) in the package.

## In CI

```yaml
permissions:
  contents: read
  pull-requests: write
steps:
  - uses: actions/checkout@v5
  # install the project and start what its tests need, as your test job does
  - uses: RadW2020/downtrace-agent/packages/check-action@main
```

The Action runs `check` against the pull request's base, keeps one comment with the routes that got worse, and fails the job when one did. [Its inputs](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/check.md#on-a-pull-request).

## What is supported

With no configuration:

| | |
|---|---|
| Frameworks | Express 4 and 5, NestJS on Express, Fastify 4 and 5 |
| Database | Postgres through `pg` or Prisma |
| Test runners | Jest, Vitest |
| Node | 18.19 or newer, other than 19 |

[`examples/`](https://github.com/RadW2020/downtrace-agent/tree/main/examples) has one small application for each combination, with the change that introduces an N+1: clone it and see `check` fail.

Others work, no guarantees: Koa, Hapi, Hono and Next.js; MySQL, SQL Server, SQLite, MongoDB and Redis; other test runners. If one fails you, [say so](https://github.com/RadW2020/downtrace-agent/issues/new).

## Without tests that reach the application

Start it with `DOWNTRACE_INSPECT`, use it, stop it, and read what each route ran:

```sh
DOWNTRACE_INSPECT=./run.jsonl node --import @downtrace/agent/register app.js
npx downtrace report run.jsonl                # each route: queries per request, what repeats, the slowest
npx downtrace compare base.jsonl run.jsonl    # check's verdict over two such files
```

[`report` and `compare`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/report.md).

## Production monitoring (experimental)

The same library, loaded in production, sends what it aggregates per route to the Downtrace cloud, which says which route got slower or started failing after a deploy. It is experimental, and it has [a page of its own](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/guide/production.md).

## Changelog and source

[`CHANGELOG.md`](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/CHANGELOG.md). The package is developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent), where issues are welcome. MIT.

In this documentation the **instrumentation** is this library and a **coding agent** is whoever runs Downtrace; the package keeps its older name.
