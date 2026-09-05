# Downtrace — open-source packages

> **Downtrace is a flight recorder for your backend.** It learns how your application normally behaves and, when something gets slower or breaks, captures what happened and tells you what changed.

[![ci](https://github.com/RadW2020/downtrace-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/RadW2020/downtrace-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@downtrace/agent)](https://www.npmjs.com/package/@downtrace/agent)

This repository is a **read-only mirror** of the public packages of Downtrace, synchronised from the private monorepo where development happens, together with the hosted backend and the project's documents. Every commit here carries the real subject of the change and every published version is tagged, so you can read what changed between two releases. The tests above run here, on this code.

Issues are welcome and answered here. Pull requests cannot be merged in place; see [CONTRIBUTING.md](CONTRIBUTING.md) for why, and how a patch gets in. To report a vulnerability, see [SECURITY.md](SECURITY.md).

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
