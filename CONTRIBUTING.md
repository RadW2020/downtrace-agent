# Contributing

## How this repository works

Development happens in a private monorepo that also holds the hosted backend and the project's documents. Everything under `packages/` is public and is synchronised here on every change, so this repository is **read-only**: a pull request opened here cannot be merged as-is, it gets ported by hand.

That is a deliberate trade-off, not neglect. The protocol schema generates the types for both the agent and the backend, and a single test runs the reference app, the agent and the backend together; keeping them in one repository is what makes those checks possible before anything is merged.

Each commit here carries the subject of the change it brought over, and every published version is tagged, so you can read what changed between two releases. Commits synchronised before September 2026 all read `sync from the monorepo`: the workflow wrote one marker into its commits and looked for a different one, so it never recognised its own previous sync and always fell back to the generic subject. That is fixed going forward, not retroactively.

## Why the code looks the way it does

`docs/adr/` carries the decision records for the code in this repository: what was decided, which alternatives lost, and what each decision costs. They cover the benchmark methodology and its statistics, how the agent observes the database driver, the protocol and the rule that governs how it may change.

Three things to know before you open them. They are written in Spanish, which is the project's language for documents. Some cite tickets, pull requests or CI runs in the private repository, which you cannot open; the decision and its reasoning are complete without them. And the code here cites decision records by number — `(ADR 0032)` in a comment — that are **not all published**: a record that also describes the hosted backend, its storage or the machines that run CI stays private, and the number in the comment is then a pointer you cannot follow. That is deliberate, not an oversight. The sentence around it says what was decided; the record says why, and for those ones the why is ours.

Decisions about the hosted backend are not published. Each record declares its own scope, so what you see here is the whole of what is public, not a summary of it.

## What is welcome

- **Issues**: bugs, questions, unexpected overhead, a framework or driver that is not observed. These are read and answered here.
- **Patches**: open an issue with the diff or a link to your branch. If it is right, it is applied upstream with attribution in the commit.
- **Benchmarks that contradict ours**: the agent claims less than 1 ms added at p99, under 3 percentage points of CPU and under 64 MiB. `packages/bench` is how we measure it. It is **not** run on every change: it is launched by hand on a quiet machine, because on a CI runner it measures the neighbours instead of the agent. Its README says how to run it and what makes a run worth trusting. If you measure something else, that is a bug report we want.

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
