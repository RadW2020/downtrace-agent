# Contributing

## How this repository works

Development happens in a private monorepo that also holds the hosted backend and the project's documents. Everything under `packages/` is public and is synchronised here on every change, so this repository is **read-only**: a pull request opened here cannot be merged as-is, it gets ported by hand.

That is a deliberate trade-off, not neglect. The protocol schema generates the types for both the agent and the backend, and a single test runs the reference app, the agent and the backend together; keeping them in one repository is what makes those checks possible before anything is merged. The cost is that this repository shows the result rather than the discussion.

Each commit here carries the real subject of the change, and every published version is tagged, so you can read what changed between two releases.

## What is welcome

- **Issues**: bugs, questions, unexpected overhead, a framework or driver that is not observed. These are read and answered here.
- **Patches**: open an issue with the diff or a link to your branch. If it is right, it is applied upstream with attribution in the commit.
- **Benchmarks that contradict ours**: the agent claims less than 1 ms added at p99, under 3 percentage points of CPU and under 64 MiB. `packages/bench` is how we measure it, and it runs in CI on every change. If you measure something else, that is a bug report we want.

## Running the tests

```sh
pnpm install
pnpm -r run test                                    # unit tests, no services needed
docker compose -f packages/reference-app/docker-compose.yml up -d
DATABASE_URL=postgres://downtrace:downtrace@localhost:5432/downtrace \
REDIS_URL=redis://localhost:6379 pnpm -r run test:integration
```

The reference app and the benchmark need Postgres and Redis; the agent and the protocol do not.

## Conventions

TypeScript strict with ESM, formatted and linted by Biome (`pnpm exec biome check --write .`). Conventional Commits. Tests are not weakened to make them pass: if a test is wrong, say so in the issue.
