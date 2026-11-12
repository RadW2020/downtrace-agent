# Compare two runs before you deploy: `downtrace check`

Part of the documentation of [`@downtrace/agent`](../README.md).

```sh
npx downtrace check --base origin/main -- npm test
```

It runs your tests twice — on the base you name, in a temporary checkout of its own, and on your working tree as it is — with the instrumentation writing locally, and compares the two route by route **by composition**: which queries, outgoing calls and Redis commands each request ran, by fingerprint, and how many times. For each route it says one of three things:

- **worse**: an operation appeared that the base did not run, or one runs at least 25% and at least half an execution more per request than it did. It names the operation by its fingerprint and says how many times a request ran it. A setting of the session, and an operation in the place of one that is gone, are the two exceptions (below).
- **unchanged**: the route was evaluated and nothing of that kind got worse. An operation that is gone or runs less is listed, and is not worse.
- **not evaluated**: the run cannot say, and says why. A route is never presented as unchanged because nothing was looked at.

It needs no account and sends nothing anywhere: the runs are given no token and no URL, so the instrumentation can only write a file, and `git` runs with no hook of yours, no LFS download and no password prompt. It never checks out, stashes or resets anything in your working tree; the base is a worktree under your temporary directory, outside the repository, that is removed when the runs end, however they ended. Installed with the project, `npx downtrace check` finds this package's command; where `@downtrace/agent` is not installed, `npx @downtrace/agent check` is the same command, and `npx downtrace` is not: it would look for a package of that name on the registry, which is not ours. It is tried on macOS and Linux, and its test command is run by a POSIX shell.

## What it answers, and what it does not

**Composition, never latency.** Durations are shown beside each verdict as data — the mean time of a request, the time per execution of an operation — and no verdict depends on one: the traffic of a test run is not production's and the machine it runs on is not quiet. The comparison is per request, so more traffic through the same code is not a regression. What a small fixture shows is the operation that appeared and how many times it repeats — five executions where production would see fifty — and that is what it names.

**What it says nothing about** is what only real traffic produces: a dependency that degrades, a pool that saturates, a change of load, an error that depends on production's data. The errors beside the operations are not judged either; the test command's own result is where a failing test shows. Those are what production is for.

**Operations are the same operation by fingerprint**, with one exception made for your machine: a call or a command to `localhost`, `127.0.0.1` or `[::1]` is the same operation whatever its port, because a test's stub server on a port the system picks has another port on every run and would otherwise be an operation that appeared beside one that vanished. A bucket of requests that belongs to no route of yours is not judged at all (below).

**A setting of the session is shown and never judged.** A query whose every statement is a `SET` of the session — `SET client_min_messages TO warning;SET TIME ZONE INTERVAL ? HOUR TO MINUTE;`, which Sequelize sends on Postgres, `SET search_path TO …`, `SET SESSION …`, `SET NAMES …`, `SET @@session.…`, `SET autocommit = ?` — is what a pool or an ORM sends when it opens a connection, inside whichever request made it open one. Which request that is, and whether a run has one at all, depends on when the pool grew and not on your code: the same tree run twice would be worse once and unchanged the next time. Such a query is listed with how it moved, marked «a setting of the session: shown and not judged», and never makes a route worse. Everything else that starts with `SET` is judged like any query: `SET LOCAL`, `SET TRANSACTION` and `SET CONSTRAINTS`, which last for a transaction your code opens (MySQL reads `SET LOCAL` as `SET SESSION`; with only the text to go by, it is judged); `SET GLOBAL`, `PERSIST` and `PERSIST_ONLY`, in either spelling, which outlive the session; `SET PASSWORD`, `SET DEFAULT ROLE` and `SET RESOURCE GROUP`; a user variable (`SET @rank = 0`), which is your code's own data; a text that sets the session and also does something else; a query whose text did not travel or was cut. A Redis `SET` is a command, and a write: it is judged.

**An operation in the place of one that is gone is not worse.** A query whose text changed has another fingerprint, so the old one is gone and the new one appeared, and the route does the work it did: the join that fixes an N+1 is exactly that. Such an operation is listed as «replaced», beside the one that is gone, when all of this holds for its kind (queries, outgoing calls or Redis commands): something of that kind is gone; what appeared runs, in all, no more per request than what is gone ran; and each one that appeared runs at most once per request. One query gone and two appeared is one query more, and both are worse, since which one is new cannot be told. Five queries removed do not pay for a loop of five. An N+1 passes none of it.

## Why a route was not evaluated

Each route that is not evaluated carries a code an agent can branch on, in the JSON, and a sentence in the text:

| Code | Why |
|---|---|
| `not-called` | No request reached it in either run. Only a route `check` knows the project has can be named when nobody called it, because nothing observes a route nobody asked: the routes of every Express, Fastify, Hono or Hapi application that answered a request in a run — read off its router, mounts, plugin prefixes and sub-applications included, under the template a request to each would get, and without the `HEAD` Fastify adds beside each `GET` — and the ones listed in `routes`, below. A route for every method (`app.all`, Hono's `use` on a path, Hapi's `*`), one written as a regular expression or a list of paths, and the routes under a mount whose pattern is not one string have no single name and are not read; list them in `routes` if you want them named. |
| `not-called-in-base` | The base run made no request to it: it is new, or the tests only reach it now. |
| `not-called-in-change` | The change run made no request to it: it is gone, or the tests no longer reach it. |
| `no-profile-in-base`, `no-profile-in-change` | That run saw requests to it and no profile covered them, so what they ran is unknown. |
| `nothing-observed` | No query, outgoing call or Redis command was observed inside its requests, in either run: it has none, or its dependencies were simulated or are not observed. With nothing to compare, nothing is said; a route that starts running something in the change is not this, it is worse. |
| `bucket` | A bucket of requests, not a route of the project: `(unmatched)` is what no route of the framework matched, `/_not-found` is Next.js's own, and `(other)` is what went past the cap of routes. What is in one is a mix and how many requests fall in it depends on the tests, so a bucket is listed by name and never judged, and a change in how many fall in it is never read as a route getting worse. |

If **no route** could be evaluated, `check` does not print a green result: it says no comparison could be made and lists why each route was not evaluated.

## When a run leaves no profile

The instrumentation writes what it holds when its process ends, in an orderly way or on `exit`, and in the runs `check` makes also each time it answers the last request it has in flight, before the answer leaves the process. So a runner that ends its processes with `process.exit()` — `node --test --test-force-exit`, Jest `--forceExit`, Mocha `--exit` or `--parallel` — keeps its profile ([*A test run*](#a-test-run-what-each-runner-keeps-of-its-profile), below), and so does one that terminates the threads that ran the tests — Vitest's `threads` and `vmThreads` pools — or ends the application's server with SIGKILL: Playwright's `webServer` does, unless `gracefulShutdown` says otherwise, as soon as the last test is over. What is lost is what was in flight in a process when it was ended. The file does not say that anything was lost — a process that wrote nothing looks like one that served nothing — so `check` reads the command it ran, and the package script it runs. When a run left no profile it says «the run left no profile», and names the cause it can tell from them.

The instrumentation is loaded into every process of the run through `NODE_OPTIONS`, and not with `--import` on the runner's command line: a runner's workers do not inherit the command line (Vitest's do not), and `NODE_OPTIONS` reaches every process. So a command that sets `NODE_OPTIONS` without keeping the value it inherits runs the tests with no instrumentation: `NODE_OPTIONS=--max-old-space-size=4096 npm test`, or a script `NODE_OPTIONS=--experimental-vm-modules jest`, as a Jest suite of ES modules has. Keep it: `NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=4096"`. `check` reads such a `NODE_OPTIONS` in the command and in the script it runs, and says so, with the value that keeps it, instead of naming a runner. A run in which no process wrote anything is said so, «no process of it wrote anything»: a process that loads the instrumentation writes as it ends, and after each request, so most likely it loaded in none, unless every process ended abruptly before a request reached it.

Every process writes its own lines into one file, so `check` merges them by route and counts a window or an interval that was written twice once. A route whose requests made calls that no profile covers is evaluated over the requests that a profile does cover, and the report says how many that was; one with none is `no-profile-in-base` or `no-profile-in-change`.

## The test command and the configuration

The command comes after `--`, or from `downtrace.json`, which `downtrace init` writes for `check` to read. It lives at the root of the project or of the repository, and is looked for upward from where `check` runs:

```json
{
  "check": {
    "command": "npm test",
    "routes": ["GET /products", "POST /checkout"],
    "prepare": "pnpm install --offline --frozen-lockfile",
    "timeout": 900
  }
}
```

Every key is optional. A key `check` does not know is an error, and keys outside `check` are not judged.

| Key | What it is |
|---|---|
| `command` | The test command, run by a shell; or a list of words, which is quoted for it. A command after `--` takes its place. |
| `routes` | The routes the project has, as `METHOD /template`, so that one no test calls can be named as `not-called`. An Express, Fastify, Hono or Hapi application's are read from it, so this is for the rest: Koa and Next.js, and the routes that have no single name. The template is the one the instrumentation names the route by: `/products/:id` for Express, Koa, Fastify and Hono, `/products/{id}` for Hapi, `/products/[id]` for Next.js. |
| `prepare` | A command run in the base checkout before the tests, for what a fresh checkout lacks: the install of the base's own dependencies, or what git ignores and your working tree built. When it is given, the base's dependencies are its business, and `check` links none (below), unless `link` says so. It gets `DOWNTRACE_CHECK_ORIGIN`, the directory of your project. |
| `link` | `true` or `false`: whether the dependencies and the environment files of your working tree are linked into the base (below), before `prepare` runs. Unsaid, they are when there is no `prepare`, and are not when there is. `true` with a `prepare` is for a base that needs something your dependencies build and git ignores, such as the CSS a `postinstall` compiles: `"prepare": "npm run scss", "link": true`. With `link` true, **`prepare` must not install**: the base's `node_modules` are links to yours, and an install would write into your working tree's `node_modules`, from the base's lockfile. `check` refuses the file when `prepare` runs an install itself — `npm ci`, `pnpm install`, `yarn`, `bun add` and the like, of npm, pnpm, Yarn or Bun — and says which; one inside a script it runs (`npm run setup`) it cannot see. `false` links nothing, with `prepare` or without it. When the base fails with `prepare` given and `link` unsaid, and has no `node_modules` where your working tree has one, the report says so, and names the file to write `link` in. |
| `timeout` | How long each run of the test command may take, in seconds; 900 by default, `--timeout` on the command line. A run that does not end in time is stopped, with what it started, and said. |

Options of the command: `--base <ref>` (what to compare against; `HEAD` by default, which is what is not committed yet; for a branch that is behind its base, `$(git merge-base origin/main HEAD)`), `--json`, `--config <file>`, `--timeout <seconds>`. The progress of a run goes to stderr, so that stdout is the result alone.

**How the base runs.** A fresh checkout has no dependencies, and installing them would need the network, so every `node_modules` of your working tree (to three levels below the top of the repository) is linked into the same place in the base, before `prepare` runs — unless `prepare` is given and `link` is not `true`, or `link` is `false`. Two consequences are yours to know: a tool that writes into `node_modules` writes into yours — `check` installs nothing itself, and sets `verify-deps-before-run=false` for the base's runs, and for a `prepare` that runs on the links, so that pnpm does not install on its own — and a package of your own repository that is linked into them is the working tree's, not the base's: in a monorepo, run `check` in the package that changes, or give `prepare` the install that builds the base's own. The environment files of your working tree that the base lacks — `.env`, `.env.test`, `.env.local`, in a directory the base has, to the same depth — are linked too: they are your machine's configuration, the same on both sides, and not code being compared; a `.env` your repository tracks is the base's own, and is left as the checkout wrote it. Anything else git ignores is not in the base; `prepare` can copy it from `DOWNTRACE_CHECK_ORIGIN`, or build it. When the base's tests fail asking for a file the base lacks and your working tree has — the `lib/` or `dist/` a build leaves, as Node, Vitest and Jest say it (`Cannot find module`) — the failure names it, with the `prepare` that builds it: your `build` script, run by your package manager, and `"link": true`. The checkout runs no hook of the project, fetches no LFS object and does not initialise submodules. If `check` is killed without the chance to clean up (`SIGKILL`), the temporary checkout stays under the temporary directory, and `git worktree prune` takes its entry away. Every `DOWNTRACE_` variable of your environment is dropped for the runs: they would point the instrumentation at production.

## What it hands back

For a person, text with the three columns, each route with its evidence. For a coding agent, `--json`: one object, `schema: "downtrace-check/1"` and `schemaVersion: 1`, with `status` (`compared` or `failed`), `summary` (`worse`, `unchanged`, `notEvaluated`), `base` and `change` (the ref, the commit, the command, its exit status and what the run left: processes, requests, routes, profile windows, lines it could not read, what each observer said), `notes`, and `routes`. Each route has a stable `id` (`POST /checkout`), its `verdict`, its `reasons` when it was not evaluated, `requests` and `profiledRequests` for each side, `meanRequestMs`, its `dependencies` (all the queries, all the outgoing calls, all the commands, per request, on each side) and its `operations`: for each, a stable `id`, the `hash` of its fingerprint, its `kind`, its `label`, how it moved (`appeared`, `multiplied`, `unchanged`, `reduced`, `disappeared`), whether that made it `worse`, `replacement: true` when it appeared in the place of one that is gone, `judged` (false for a setting of the session, whose movement is shown and never makes it worse), `perRequest`, `executions` and `msPerExecution` for each side, and, on an operation that got worse, its `sites` ([below](#where-the-project-ran-what-got-worse)). A comparison that could not be made has `status: "failed"` and a `failure` with a `code`, the `side`, a `message`, `advice` and the `outputTail` of the command when it is what failed: `not-a-repository`, `bad-ref`, `bad-config`, `no-command`, `setup-failed`, `command-failed`, `timeout`, `no-profile`, `nothing-evaluated`, `interrupted`.

The object's contract is a JSON Schema, published in the package: `node_modules/@downtrace/agent/schema/check.schema.json`, or `require("@downtrace/agent/check.schema.json")`. Under one `schemaVersion`, fields are only ever added, so read the ones you know and ignore the rest. A field removed, renamed or given another meaning moves `schemaVersion`, and that comes only with a major version of `@downtrace/agent`.

### Where the project ran what got worse

An operation that got worse carries `sites`: up to three places where the change run ran it, as a file relative to the project and a line, `["src/users/users.service.ts:42"]`, the innermost frame of the project in the stack of the call. The text says them under the operation, `ran at src/users/users.service.ts:42`. A frame in `node_modules`, in Node, in this package or outside the project is never one, so no place is a path of your machine; through an ORM, the place is the line of yours that called it, when the ORM awaits its way down to the driver and the stack still reaches you. Every other operation has no `sites`.

The stack is taken when your code calls, in the change run alone, and only under `check`: the run writes the places to a file of its own, beside its batches and never in them, so nothing of it goes anywhere, and production takes no stack at all. It is sampled: the first calls of each text in each request, and a bounded number of calls in all, and a route stops reading stacks for an operation once it has its three places. In this version the places are those of the queries of `pg`, and of Neon's driver, which is `pg` bundled, `pool.query()` included; an operation of another driver, or one no sampled call of reached from a frame of the project, has `sites: []`.

**When Downtrace could not see something, the report says so and offers a link; it sends nothing.** A run that left
no profile, a run in which no route could be evaluated, routes in which nothing was observed in a project that
depends on a driver the instrumentation does not observe (`oracledb`, `kafkajs`…), and an observer that found no driver in
a project that depends on one: those are what tells us what Downtrace
misses in projects we have not seen. The report then has a `feedback`, with `why` and a `url`: a new issue on
[the public repository](https://github.com/RadW2020/downtrace-agent/issues), filled in with the version, Node, the
frameworks and data packages the project depends on among names Downtrace knows, the test runner among names it
knows, and the codes of what went wrong with how many routes each covers. Never a route, a path, the test command or
its output, and never a package that is not one of those names. `check` makes no request; the link opens a form you
read, change, and submit if you want us to see it. A run with nothing of the kind has `feedback: null`, and the text
says nothing.

For CI, the exit status: **0** no route got worse, **1** at least one did, **2** no comparison could be made — the test command failed on either side (a comparison needs two runs that end well), a run left no profile, no route could be evaluated, or the command was interrupted.

## On a pull request

A GitHub Action runs `check` against the pull request's base, keeps one comment with the routes that got worse — posted the first time one does, updated on every run after — and fails the job when one did:

```yaml
permissions:
  contents: read
  pull-requests: write
steps:
  - uses: actions/checkout@v5
  # install the project and start what its tests need, as your test job does
  - uses: RadW2020/downtrace-agent/packages/check-action@main
```

It runs `npx downtrace check --json`, so the project has `@downtrace/agent` installed and the `downtrace.json` that `npx downtrace init` wrote. Its inputs: `base`, a ref other than the pull request's base branch; `working-directory`, when the project is not at the root; `github-token`, when the job's own cannot comment. The job ends with `check`'s exit status.

## With a coding agent

Paste this into the `AGENTS.md` or `CLAUDE.md` of your project:

```md
Before pushing, run `npx downtrace check`. If it exits 1, fix the routes it lists or explain why the change is intended.
```

That is all a coding agent needs: on exit 1 the text names each route that got worse, the operation that appeared or multiplied, how many times a request runs it now, and where it can the `file:line` of yours that ran it. Exit 2 is no comparison, and says why. An agent that would rather read an object than text adds `--json`.

## A test run: what each runner keeps of its profile

A profile covers a minute and a test run lasts seconds, so what a run keeps of its profile is what each process hands
over as it ends, and how a process ends is the runner's doing and not your application's. To profile a run, load the
instrumentation into **every** process the runner starts, and name a file:

```sh
DOWNTRACE_INSPECT=./downtrace-run.jsonl NODE_OPTIONS="--import @downtrace/agent/register" npx vitest run
```

`NODE_OPTIONS` is inherited by every process and thread a runner starts. `--import` on the command line is not: a
runner decides which of its own flags it passes on, and Vitest's workers do not get it, so a run started with
`node --import @downtrace/agent/register node_modules/vitest/vitest.mjs run` is observed in the process that started
it and in none that ran a test (by hand, on Vitest 4.1.11; `node --test` and Mocha's workers do get it). With no token
and no URL nothing leaves the machine, and each process writes what it holds as it ends — on `exit` too, so a runner
that ends a process with `process.exit()` and waits for nothing loses nothing. What each runner does, and what the
file holds when the run is over:

| Runner | How it ends the processes its tests ran in | The profile of every route the tests called |
| --- | --- | --- |
| Vitest, `forks` pool (the default) | a signal, which the instrumentation's own handler answers | kept (`runners.test.ts`) |
| Vitest, `threads` or `vmThreads` pool | terminates the thread, and a terminated thread runs nothing | **lost** with `DOWNTRACE_INSPECT` alone (`runners.test.ts`); kept under `downtrace check`, where a thread writes each time it has no request in flight (`check.test.ts`) |
| `node --test` | each file's process ends when its loop empties | kept (`runners.test.ts`) |
| `node --test --test-force-exit` | `process.exit()` | kept, written on `exit` (`runners.test.ts`) |
| Jest — in band, in workers or in worker threads, with or without `--forceExit` | workers end on their own; in band, `--forceExit` ends the process with `process.exit()` | kept, written on `exit` when forced — **by hand** |
| Mocha — default, `--exit` or `--parallel` | ends on its own; `--exit` and the workers of `--parallel` end with `process.exit()` | kept, written on `exit` when it exits — **by hand** |

The rows with a test were run by the real runner, Vitest 4.1.11 on Node 24. The two marked **by hand** were run once,
against Jest 30.5.2 and Mocha 12.0.3 on Node 24, and no test asserts them; Jest is in this package's tests for its
module registry ([below](#a-test-run-what-each-runner-keeps-of-its-profile)), not for this row. Also by hand, on Vitest 4.1.11, its `vmForks`
pool and `--no-isolate` behave as the `forks` row says and its `vmThreads` pool as the `threads` row does; and Vitest
5.0.3 behaves as 4.1.11 in the default pool and in `threads`.

**Under Jest, the instrumentation reaches into Jest's own module registry.** Jest runs a test
file's modules in a registry and a context of its own: the `pg`, `mysql2`, `mysql`, `mariadb` (up to 3.4), `tedious`, `mssql`, postgres.js, MongoDB and Express the tests use are
not the ones in Node's module cache, which is where the instrumentation finds them everywhere else. So when Jest
loads `jest-runtime`, the instrumentation wraps the `requireModule` every `require` of a test file goes through, and
patches the copies Jest hands the tests: their queries are counted and their Express routes are named by their mounts,
as anywhere else. From Node 22.4, Node announces that load on its `module.require` channel. Before 22.4 it announces
nothing, and under `check`, in a project where `jest` resolves, the instrumentation watches `require` itself from its
start until Jest has loaded `jest-runtime`, which each process of Jest does before it reads a test file, and then gives
`require` back. The watcher calls Node's `require` with what it was given and returns, or throws, what it did. Checked
by `check.test.ts` on Jest 30 and 29, in band and in two workers, with Express 4 routers mounted under routers, on a
Node that announces and on one that does not; and by `scripts/pack-test-jest.sh` on the packed package with Jest 29 and
`pg`, on Node 18.19.0 and 24. What reaches Node's own modules — HTTP, Fastify, the Redis clients — never needed it.
**Before Node 22.4, outside `check`** — a suite run with `--import @downtrace/agent/register` and `DOWNTRACE_INSPECT` —,
or in a project from which `jest` does not resolve (Jest brought by another package, as `react-scripts` brings it,
under pnpm), a suite Jest runs has no queries from those drivers, and its Express routes under a mount come out as
`/:param/:param/:userId`; on Node 22.4 or later both are reached. Jest's ESM mode (`--experimental-vm-modules`) is not
reached.

**Vitest's thread pools are the one case that loses it, and nothing in a thread can change that.** A terminated thread
fires no `beforeExit`, no `exit` and no signal: what it held goes with it, and the file does not have its routes. Use
the `forks` pool, which is the default. If you need threads, end each test file with `await shutdown()` from a setup
file — `afterAll(() => shutdown())` — and the thread hands over before it is terminated. That works with isolated
threads, a thread per file, which is Vitest's default for the pool; in a thread that runs more than one file only the
first is observed, because `shutdown()` stops the observation. Checked by hand against the built package, not by a
test.

Three things about reading the file. It is written by every process, not only the ones that ran tests: a helper process
a runner starts that ended in order writes one batch with no interval and only its `ending`, and you can ignore it. A
route is in a profile only when it ran something — a query, an outgoing call, a Redis command or an error — so a route
that ran nothing is in the aggregates and has no profile at all. And a profile that never arrived, like the one of a
terminated thread, is not an empty one: the file does not say it was lost, so a route you cannot find in it is a route
you did not observe, never a route that did not change.
