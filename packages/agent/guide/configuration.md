# Configuration

Part of the documentation of [`@downtrace/agent`](../README.md).

Every setting is an option of `init()` and a variable of the environment, and both mean the same: an option given in code wins, and one left out is read from its variable; with neither, the default applies. The option is the variable's name in camelCase without the prefix. A flag is `true` or `false`, a number is a number, and a list is an array or a comma-separated string, as in the variable. An option of the wrong kind is named in one warning, never with its value, and left to its variable; one `init()` does not have, Sentry's `environment` or `release`, is named too.

| Option | Variable | What it is |
|---|---|---|
| `dsn` | `DOWNTRACE_DSN` | The cloud's URL with the ingest token as its user, `https://dt_…@your-downtrace-cloud`: one string that connects |
| `token` | `DOWNTRACE_TOKEN` | Without a DSN: the ingest token for this project **and environment** |
| `url` | `DOWNTRACE_URL` | Without a DSN: the base URL of the cloud, `http://` or `https://`; trailing slashes are ignored |
| `env` | `DOWNTRACE_ENV` | Environment; falls back to `NODE_ENV`, then `production`. The token's environment is what decides where the data lands ([why](../README.md#install)) |
| `version` | `DOWNTRACE_VERSION` | Deployed version or commit. Unset, it is looked for in this order: the variable your platform or CI sets (`VERCEL_GIT_COMMIT_SHA`, `CODEBUILD_RESOLVED_SOURCE_VERSION`, `GITHUB_SHA` and [the rest](https://github.com/RadW2020/downtrace-agent/blob/main/packages/agent/src/config.ts)), then on ECS the image's digest (`image:sha256:…`), then a fingerprint of your code (`code:…`); `unknown` only if none answers. [How](data.md#the-deployed-version) |
| `inspect` | `DOWNTRACE_INSPECT` | `stderr` or a file path: writes every batch exactly as it would be sent. With it set, the DSN, or the token and the URL, become optional ([how](../README.md#see-exactly-what-would-leave-your-server)) |
| `debug` | `DOWNTRACE_DEBUG` | `true` (`1` or `true` in the variable) to log the instrumentation's own activity to stderr |
| `intervalMs` | `DOWNTRACE_INTERVAL_MS` | Aggregation interval in ms (min 1000; default 10000; anything else falls back to the default) |
| `profileMs` | `DOWNTRACE_PROFILE_MS` | How long a profile window stays open, in ms (default 60000; never below the interval, and never above two and a half minutes minus the interval — [why](data.md#what-each-route-normally-runs)). Shortening it multiplies the profile rows in proportion, and those count against its environment's daily budget |
| `instrument` | `DOWNTRACE_INSTRUMENT` | Which observers run: `all` (default), `none`, or a list like `pg,mysql,sqlite,mongodb,prisma,http,redis,runtime` |
| `minimal` | `DOWNTRACE_MINIMAL` | `true` (`1` in the variable) to send no free text at all ([what that withholds](../README.md#what-leaves-your-server)) |
| `queryText` | `DOWNTRACE_QUERY_TEXT` | `false` (`off` in the variable) to send query fingerprints without their normalised text. The hash is the identity, so the analysis is unchanged |
| `excludeEndpoints` | `DOWNTRACE_EXCLUDE_ENDPOINTS` | Route templates not to observe at all; `*` stands for any run of characters and the whole template has to match (`/admin/*`). The cloud is told how many are missing, never which |
| `excludeDependencies` | `DOWNTRACE_EXCLUDE_DEPENDENCIES` | Dependency targets not to observe at all, the same way (`api.stripe.com`) |
| `shed` | `DOWNTRACE_SHED` | `nothing` (default), `fine` or `profile`: the least the instrumentation gives up, whatever its own meter measures. The benchmark's switch; leave it alone in production |
| `pgDepth` | `DOWNTRACE_PG_DEPTH` | `full` (default), `context` or `wrapper`: how much of the Postgres observer's attribution runs. The benchmark's switch; leave it alone in production |

## Connecting

A DSN wins over a token and a URL beside it, and the code's token or URL wins over the environment's, which fills what the code left out: `init({ token })` with `DOWNTRACE_DSN` set takes the URL from the DSN. A DSN is split when it is read, and its token travels in a header, never in a URL. One that is not a URL, has no token, or carries a password, a query or a fragment is said in one warning that never echoes it, and the instrumentation stays off. So is a `DOWNTRACE_URL` with the token in it, which Node's `fetch` would refuse.

## One instrumentation per process

A second `init()`, or one after `--import @downtrace/agent/register` started the instrumentation, starts nothing and says so: the first one keeps its settings. That holds across two copies of the package in one process, an ES module one and a CommonJS one, or the one `downtrace check` loads and your application's. A register entry that stayed off, with nothing to connect with, started nothing, and `init()` starts it.

Nothing has to be loaded after `init()` to be observed: a library your application loaded before it is wrapped where it is. What your application built with some before `init()` is what is lost: a router Express mounted is named without its mount path, a Fastify instance names its routes by the shape of their paths, an `mssql` pool and a Prisma adapter for MariaDB connected are not observed. When `init()` runs after your application loaded any of those, one warning names them. Load the instrument file before anything else, and none of it applies.
