# Downtrace — open-source packages

> Your coding agent just introduced an N+1. `downtrace check` catches it before you push.

`downtrace check` compares two runs of your tests and names the routes that got worse: a query that now runs once per row, a query or an outgoing call that was not there. A developer, or their coding agent, runs it before pushing. No account, and nothing leaves the machine.

[![ci](https://github.com/RadW2020/downtrace-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/RadW2020/downtrace-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@downtrace/agent)](https://www.npmjs.com/package/@downtrace/agent)

In a Node.js project whose tests reach it over HTTP:

```sh
npm install --save-dev @downtrace/agent
npx downtrace init && npx downtrace check
```

When a change adds an N+1, it exits 1 and says `GET /posts … appeared   select name from authors where id = ?   0 -> 5 per request   ran at src/app.js:9` while your tests still pass. [The three commands, with a coding agent and in CI](packages/agent#readme) · [try it on an example](examples) · [how it decides](packages/agent/guide/check.md).

The same library also monitors production with the Downtrace cloud. That half is experimental: free, no plans, no billing and no SLA, on a protocol, `v0`, that can still change between minor versions. [Its page](packages/agent/guide/production.md).

This repository is a **read-only mirror** of the public packages of Downtrace, synchronised from the private monorepo where development happens, together with the hosted backend and the project's documents. Every published version is tagged and every commit carries the subject of the change it brought over, so you can read what changed between two releases. The tests above run here, on this code, and the packages are published to npm from this repository so that npm can attest their provenance.

Issues are welcome and answered here. Pull requests cannot be merged in place; see [CONTRIBUTING.md](CONTRIBUTING.md) for why, and how a patch gets in. To report a vulnerability, see [SECURITY.md](SECURITY.md).

| Package | What it is |
|---|---|
| [`packages/agent`](packages/agent) | `@downtrace/agent` — the Node.js agent (`node --import @downtrace/agent/register`) |
| [`packages/check-action`](packages/check-action) | The GitHub Action that runs `check` on a pull request, keeps one comment with the routes that got worse and fails the job when one did |
| [`examples`](examples) | One small application per supported combination, each with the change that introduces an N+1 |
| [`packages/protocol`](packages/protocol) | `@downtrace/protocol` — the ingestion contract: JSON Schema, fixtures, generated types |
| [`packages/reference-app`](packages/reference-app) | A reference backend with switchable regressions (N+1, slow dependency, aggressive retries, pool leak, new error) used as benchmark target and test bed |
| [`packages/mcp`](packages/mcp) | `@downtrace/mcp` — the same queries and operations as tools a coding agent can discover and use, over MCP |
| [`packages/coding-agent`](packages/coding-agent) | What a coding agent reads to use Downtrace: a block for a project's `AGENTS.md`, and a Claude Code plugin (`claude plugin marketplace add RadW2020/downtrace-agent`) |
| [`packages/bench`](packages/bench) | The agent overhead benchmark: the agent must add < 1 ms at p99, < 3 pp of CPU and < 64 MiB, measured against the reference app. [Its README](packages/bench#readme) says how it is run and when its number is worth anything |

```sh
pnpm install
pnpm -r test
```

The reference app and the benchmark need Postgres and Redis (`packages/reference-app/docker-compose.yml`).

MIT © Raúl Jiménez
