# Security

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/RadW2020/downtrace-agent/security/advisories/new). Please do not open a public issue for a vulnerability.

Expect an acknowledgement within 72 hours and an assessment within a week. If a fix is needed, the advisory is published together with the release that carries it.

## What the agent does to your application

The agent is loaded with `node --import @downtrace/agent/register` and runs inside your process, so it is worth knowing exactly what it touches:

- It subscribes to Node's `diagnostics_channel` for incoming HTTP requests. That is observation, not interception.
- It wraps one method, `pg`'s `Client.prototype.query`, to count queries per request. The wrapper passes arguments, results and errors through untouched, and if the wrapper itself throws, your query still runs. `DOWNTRACE_INSTRUMENT=none` disables it.
- It sends aggregates with `fetch`, outside the request path, on a bounded queue. If the destination is unreachable, batches are dropped; your application is not affected.
- Every hook is wrapped in a guard. After 10 internal errors the agent disables itself and says so once.

It never reads request bodies, headers, query strings, query text or query values. What leaves your server is listed in the README and fixed by the JSON Schema in `@downtrace/protocol`.

## Supported versions

The latest published minor of `@downtrace/agent` and `@downtrace/protocol` receives fixes. There are no long-term support branches while the project is pre-1.0.
