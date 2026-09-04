# Downtrace — open-source packages

> **Downtrace is a flight recorder for your backend.** It learns how your application normally behaves and, when something gets slower or breaks, captures what happened and tells you what changed.

This repository is a **read-only mirror** of the public packages of Downtrace, synchronised automatically from the private monorepo where development happens. Issues are welcome here; pull requests are ported by hand.

| Package | What it is |
|---|---|
| [`packages/agent`](packages/agent) | `@downtrace/agent` — the Node.js agent (`node --import @downtrace/agent/register`) |
| [`packages/protocol`](packages/protocol) | `@downtrace/protocol` — the ingestion contract: JSON Schema, fixtures, generated types |
| [`packages/reference-app`](packages/reference-app) | A reference backend with switchable regressions (N+1, slow dependency, aggressive retries, pool leak, new error) used as benchmark target and test bed |
| [`packages/bench`](packages/bench) | The agent overhead benchmark: the agent must add < 1 ms at p99, < 3 pp of CPU and < 64 MiB, measured against the reference app on every change |

```sh
pnpm install
pnpm -r test
```

The reference app and the benchmark need Postgres and Redis (`packages/reference-app/docker-compose.yml`).

MIT © Raúl Jiménez
