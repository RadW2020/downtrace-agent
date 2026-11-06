# What leaves your server

Part of the documentation of [`@downtrace/agent`](../README.md). Everything a batch carries, what never travels, and what to switch off. To read the batches themselves, see [See exactly what would leave your server](../README.md#see-exactly-what-would-leave-your-server).

Only structural metadata: method, **route template** (`/products/:id`, never the actual URL), status, counts and a fixed-bucket latency histogram per route and interval, plus the process identity (random id, hostname, pid) and the deploy (version, environment). No bodies, no headers, no query strings. The exact contract is the JSON Schema in [`@downtrace/protocol`](https://www.npmjs.com/package/@downtrace/protocol).

That is what goes out every ten seconds. Three other things can leave, and they are listed here rather than left for
somebody to find in a schema: **the detail of a capture**, **reference samples** and **the instrumentation's own
resources**. Each has its own section below. None of them carries a value from your database, a body, a header or a
URL — the same rule as the aggregates, and `DOWNTRACE_INSPECT` shows you all of it.

## The health of your process

Every interval the instrumentation also reports how late Node's event loop ran (median, p99 and worst), how much time went to
garbage collection, heap and resident memory, and the peak number of requests in flight. In Node many slowdowns are
neither the database nor the network but the process itself, and a diagnosis that does not measure it will blame
whatever it does measure. It all comes from Node's own instruments, which run whether anyone looks at them or not.

## Database work per request

Queries, statements and commands per request, and what each driver sends: see [Databases](databases.md).

## Calls to other services

Outgoing HTTP is reported the same way, grouped by the host your application asked for: how many calls per request,
how long they took, the slowest one, and how many failed. A 5xx from a dependency counts as a failure of that
dependency, because for "is this service degraded?" a 500 and a timeout are the same answer.

`fetch` and the `node:http` client both publish on Node's `diagnostics_channel`, and the instrumentation listens. There is one
exception: when a `fetch` cannot connect at all, undici publishes nothing, and that is exactly the case where a
dependency is down. For that, and only that, the instrumentation wraps `globalThis.fetch`: if a call rejects and nothing was
recorded for it, it counts as a failed call. On every other path the wrapper does nothing.

Each call is also an **operation** of the route that made it, beside its counter: in the route's profile and in the
black box, with when it started and when it ended. It is named by its method and the host it asked for —
`POST api.stripe.com` — and never by its path or its query string. Two calls to the same provider that overlapped are
two operations that overlap in a capture, which is what tells «three calls one after another» from «three calls at
once». The name is made once per method and host and kept, so a call costs a lookup, not a hash.

## Redis

The commands each request issues are reported the same way, per server: how many per request, how long they took and
how many failed. Both Redis clients publish on a tracing channel, so nothing is patched: ioredis, and node-redis
(`redis`, `@redis/client`) from 5.12. A node-redis older than 5.12 publishes nothing, and its commands are not seen;
`npm install redis@latest` is what it takes.

Each command is also an **operation**, in the profile and in the black box, named by the command and its server —
`HGETALL cache:6379` — and never by its key or its arguments, which both clients put on the channel and the
instrumentation does not read. A node-redis transaction (`multi()…exec()`) is one operation, `MULTI cache:6379`:
node-redis publishes the transaction and not the commands inside it, so a change that adds a command to a
transaction is not seen, and one that runs a transaction per item is. A pipeline (`execAsPipeline()`) is the
commands it ran, which node-redis publishes one by one. A Redis reached through a unix socket has a path for its server, which no label may
carry, so its commands travel with their hash alone; a command the channel does not name is counted and is not an
operation.

Every dependency carries a **target** saying which instance of its kind it is, taken from the driver: the host for
outgoing HTTP, host and port for Postgres through `pg`, MySQL and Redis. A read replica and a primary are two dependencies, not one
(through postgres.js they are one, [with no host](databases.md#postgresjs)).

The first 60 distinct destinations a route talks to in an interval keep their target; past that, the rest fold into
one row of their own kind with target `(other)`. The folded destinations' calls, time and errors are in that row —
summed per request, so a request that talked to three of them counts once — and nothing of them is dropped. The cap
is there because a batch the schema refuses is dropped whole, and it would be the interval of every route, not only
the one that went past.

The instrumentation loads before your application (`node --import`), so it wraps the driver before you import it and you write
no code. The wrapper passes arguments, results and errors through untouched, and a failure inside it runs your query
anyway. `DOWNTRACE_INSTRUMENT=none` turns it off.

## What each route normally runs

The instrumentation also builds a **profile**: not only that a route made 4 queries, but which ones — and which
outgoing calls and Redis commands it made, as above.
Each query text is reduced to its shape — `SELECT id FROM products WHERE id = ?` — and hashed, read as the SQL of the
database it was sent to. The hash is the
identity the cloud groups and compares by; the text is only the label you read. That is what lets Downtrace say
*«this route went from 2 executions of this query to 53»* instead of *«this route makes more queries now»*.

The profile goes out **once a minute**, separately from the 10-second aggregates, because what a route runs
changes when your code changes, not every ten seconds. The minute is the default; `DOWNTRACE_PROFILE_MS`
moves it, between a floor and a ceiling, and both are derived rather than chosen:

- **The floor is the interval.** A profile window closes on the first flush after it is full, and the flushes
  come every interval. A window shorter than the interval that feeds it closes on the very same flush as one
  equal to it, so below `DOWNTRACE_INTERVAL_MS` the number stops meaning anything.
- **The ceiling is two and a half minutes minus the interval.** It is derived from the window that reads the
  profile: the report's diff reads the recent window as the last five minutes, ending one minute ago — the
  minute being the arrival budget, what is flushed by then has arrived by the check — and it counts a profile
  window on the side where it *starts*. A window is only in the store once it has closed and been flushed,
  which is the first flush after it is full, at most one interval later. For the five minutes to hold a
  profile that has arrived **at every phase**, two whole windows, each with its flush, must fit in them:
  twice (profile + interval) ≤ five minutes. Above the ceiling there are phases in which the report's window
  holds no profile that has arrived, whatever the instrumentation is sent, and the report then says
  `no-profile-after` of a route that was profiled as asked.

A value below the floor is taken as the floor without saying anything, because that is a no-op; a value above
the ceiling is clamped to it and said once at start-up, because that is not a no-op: the cadence in effect is
not the one you wrote, and the profile rows you pay are not the ones you asked for.

**No value from your database ever leaves your server.** Literals, parameters, quoted bodies and comments are
replaced before anything is stored or sent, and that happens in your process, not ours. If you would still rather
not send the query text at all, `DOWNTRACE_QUERY_TEXT=off` suppresses it — with every other label of the profile,
the calls' and the commands' included — and changes nothing else: the hash is the identity, so you keep the whole
analysis and only lose the readable label.

**A long quoted name stays when it reads as words.** An ORM quotes every name it writes — Kysely, Sequelize, TypeORM
and Prisma all do — so `update "users" set "dateOfLastAccess" = $1` is `update "users" set "dateOfLastAccess" = ?`,
and a name between MySQL's backticks stays the same way. A name of sixteen characters or more stays when its case or
its `_` and `-` break it into words: `dateOfLastAccess`, `maintainer_approval_required`. What a name built from data
carries is still replaced: a run with a digit in it (`"tenant_8f3a9c2e1b7d4f60"`), a UUID, an email, a run whose case
breaks it into words shorter than three letters on average, as a generated token's does (`"kQzXwPfLmNbVtRsY"`), and
sixteen letters or more that nothing breaks (`"tenant_kqzxwpflmnbvtrsy"`, and a long name written in one case, such
as `"userpreferenceshistory"`, with them). A name made only of such values is `?` whole. A name built from data out of
words has the shape of a name and travels as one (`"alice_smith_marketing"`); `DOWNTRACE_QUERY_TEXT=off` keeps it
home.

**The first version that keeps long quoted names changes some query fingerprints, once.** Earlier versions replaced a
quoted name with a run of sixteen characters or more in it with `?` even when it was a plain name, so the update above
was `update "users" set ? = ?`, with the hash of every other update of one such column of `users`. Such a query now
has the name in its label and a hash of its own, so after the upgrade Downtrace sees it as a new query and the old
one stops being seen. A query whose quoted names have no such run, or one with a digit in it or that reads as a
token, keeps its hash, and so does every query with no quoted name.

## When someone asks for detail: a capture

The instrumentation keeps a **black box** in memory: the last tens of seconds request by request, with the operations each
one ran and when each started and finished, plus a coarser summary of the last few minutes. Nothing of it leaves your
server on its own. It leaves when a capture asks for it — and a capture is asked for in one of two ways: the cloud asks,
in the answer to a batch, or **the instrumentation asks for one itself** when a local signal says the process is in
trouble (today: the event loop running more than 250 ms late, at the p99, for two intervals in a row).

What travels then is the same kind of thing as an aggregate, one level finer: for each request, its **route template**,
method, status, when it started and how long it took, and the operations it ran as **hashes** with their kind — a
query, a call, a command, or an error beside them — and their starts and ends.
Never the query text, never a value, never a path. Order and overlap are the whole point — they are what separates «this
request spent 400 ms waiting on the database» from «it ran three queries at once».

Beside it goes the **coarse summary of the last few minutes**: per endpoint, second by second, how many requests, how many
failed, how long they took in total and at the worst, how many database calls they made — and the process's own event loop
delay as a series of its own, since a slow loop belongs to no endpoint. The fine detail says what the captured requests
did; the summary says what the rest of the process was doing around them, which is what makes a degradation that was
detected late readable as a beginning. A quiet second travels as zeros; a second nobody watched travels as absent — the
cloud can tell the two apart, and so can you.

It also says what it could **not** give you: how many requests it observed from the moment it started watching, how many
it attached from detail it still had, and how many lost their detail before it could be read. A capture that saw nothing
sends an empty answer rather than silence.

## A few requests to compare against: reference samples

A capture of what went wrong is worth little without something to compare it with, and the fine detail of an hour ago no
longer exists. So the instrumentation keeps a handful of requests per endpoint — a **uniform reservoir**, so every request
has the same chance of being kept, whatever it did — and sends them with a capture, saying how they were chosen. They have
exactly the same shape as the captured requests, and the same rule: hashes, never text.

## What the instrumentation itself costs

Every batch can carry what the instrumentation is spending and losing: batches it dropped because its queue was full,
batches the cloud refused, batches it could not send, errors inside itself, the memory its registers hold and an
**estimate** of its own hook time per request. Numbers about the library, not about your application — and the reason they
travel is that a cloud seeing nothing has to be able to tell «nothing happened» from «this instrumentation has been
throwing batches away for two hours».

## The deployed version

Every batch says which deploy it comes from, and the comparison of one deploy with the one before is built on that. You
do not have to set it. At start-up the instrumentation looks for it, from the most explicit source to the most generic,
and the first that answers chooses it:

1. `DOWNTRACE_VERSION`, when you set it.
2. A variable your deploy platform or your CI sets: `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`,
   `RAILWAY_GIT_COMMIT_SHA`, `HEROKU_BUILD_COMMIT`, Coolify's `SOURCE_COMMIT`, `CODEBUILD_RESOLVED_SOURCE_VERSION`,
   `GITHUB_SHA`, `CI_COMMIT_SHA` and
   [the rest of the list](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/src/config.ts), in its
   order. A CI's variables exist during the build, so they count when the build passes them on to the application, with
   `ARG` and `ENV` in a Dockerfile for instance. Where a platform sets no commit, the name it gives the deploy: Fly.io's
   image, Cloud Run's revision, App Engine's version.
3. On ECS, the digest of the container's image, from the task metadata endpoint the ECS agent gives every container:
   `image:sha256:…`. One request to that endpoint at start-up, with a one-second timeout.
4. Anywhere else, a fingerprint of your code: `code:` and 16 hexadecimal digits. It is a hash of the content of your
   code files (`.js`, `.ts` and their kin), `package.json` files and lockfile, under the closest directory above your
   entry that has a `package.json`. `node_modules`, version control and every other file are left out, so neither a
   restart nor a log, an upload or a newer file time changes it, and two instances of one build agree on it. A new
   build with any change to that code gets a new one. It reads at most 5,000 files and 32 MiB, one file at a time, off
   the path of every request; a larger application is fingerprinted by what fits, read in the same order on every
   instance. Only the hash leaves your server. Kubernetes sets nothing of the kind, and this is what covers it.

The prefixes are there so that nobody reads an image digest or a fingerprint as a commit: in the cloud, through the MCP
server and in a batch you inspect, a version that begins `image:` or `code:` says what it is.

A process says one version for its whole life, never `unknown` first and the real one after: that would read as two
deploys. So the first batch waits for the search, ten seconds at most from the start, and nothing in the search delays
your application's start or reaches it if it fails. A process that leaves before the search has finished says `unknown`.

With `DOWNTRACE_DEBUG=1`, one line says which source chose the version, and what it passed over on the way:

```
[downtrace] version: code:5e884898da280471, from a fingerprint of 812 files under /app (the ECS task metadata answered 404)
```

In minimal mode, below, the version travels as a digest of itself, whichever source chose it.

## Sending no free text at all

`DOWNTRACE_MINIMAL=1` withholds everything you wrote. Route templates, dependency targets, your hostname
and your deployed version travel as stable digests of themselves — same name, same digest, every time, so
the analysis still groups — and query text, the labels of outgoing calls and Redis commands, error messages and
exception signatures do not travel at all. A call's or a command's identity is then a digest of its withheld name.

The digest is of what the route is called. A request that Express or a Koa router answered and no route named is
`(unmatched)`, and nothing of its path enters the digest. For a request that no framework with routes saw, it is the
collapsed route, so a value the heuristic folds — an email, a token, a file name with a number — never enters the
digest. The limit is a plain word in a path of that kind, a name or a slug: the heuristic cannot tell it from the
route's own words, so it enters the digest, and the digest is keyless, which means whoever guesses the word can
confirm it. An endpoint exclusion keeps it out entirely, because excluding is not observing.

What stays is what is not yours: the protocol version, the agent's own name, the HTTP method, the kind of
each dependency, the counts and the timings. Downtrace keeps detecting and comparing; what it loses is the
ability to **name** anything, and it says so in every report rather than showing you a bare hash.

The environment is not withheld: your ingest token already tells the cloud which one it is, so hiding it
here would protect nothing and would collapse the per-environment scope everything is organised by.

`DOWNTRACE_QUERY_TEXT=off` still exists and still does the smaller thing: send the routes, not the queries.
It is about queries, so it does not touch the context of an error you report.
