# 0205 — The number the world will see is checked before the versions PR is built

Estado: aceptado · Fecha: 2026-09-28 · Alcance: público

## Context (gh-703)

`release.yml` opens and updates the "Version Packages" pull request with `changesets/action` and the
workflow's `GITHUB_TOKEN`. GitHub does not fire workflows from a pull request that token opens without an
approval, and the approval is never given: every `pull_request` run of `changeset-release/main` ends
`action_required` with zero jobs, created and closed in the same second, and the PR — #542, open since
2026-09-13 — carries no check at all.

The workflow was written as if it ran there. The `node` job of `ci.yml` said of `make check-protocol-version`
that it runs on the version PR too, "the branch where the number the world will see actually appears", and
ADR 0019 repeated it: the check works in the versions PR itself, where the number the world will see appears.
It never ran there.

So neither of the two checks that protect the publish ran on the commit that is published: the one that says
the package version and the protocol it speaks are one number (ADR 0019), and the one that consumes the
tarballs on Node 24, 22 and 20. The first ran again on the push to `main` after the versions PR merged —
after the publishing half had already run. The second only on the pull requests that changed the code.

## Decision

**The checks that protect the publish run in `release.yml`, on the push to `main`, before `changesets/action`
is asked for anything.**

- **The protocol version check runs on every push**, in the `release` job, and it is seconds. It compares
  what the pending changesets would publish against what the schema speaks — the question the publish asks —
  on the commit the versions PR is built from. A red step freezes the versions PR where it is, because the
  action runs after it: a bad number is never the one the PR is built from. The `report` job opens the
  `red:release` issue (ADR 0183): the failure is seen where people already read, and what is blocked is the
  publish, not a pull request.
- **The tarball check runs on the pushes that touch what the mirror publishes** — the same paths `mirror.yml`
  syncs — packing the publishable packages and consuming the tarballs on Node 24, 22 and 20. A push that
  changes nothing publishable spends no lane on it. On the merge of the versions PR that is the only run on
  the commit that is published, because nothing runs there; on an earlier push the pull request that changed
  the code already ran it on its own head.
- **The versions PR runs no CI, and its `action_required` runs are never approved.** What an approval would
  re-run is what the push that built the PR just ran, over a diff of version numbers and changelogs. The
  approval is per run, and the PR is updated on every push that carries a pending changeset: the release
  would then stand on a human in the Actions tab on every one of them.
- **The versions PR is merged by the operator, after reading its diff.** The merge is the publish, and
  CLAUDE.md already keeps the publish out of a session; what was not written was who does it, and why no
  check stands between the diff and the merge. This is where it is written.

## Alternatives

- **Open the PR with a token that does fire workflows** (a GitHub App or the operator's, with a
  `GITHUB_TOKEN` fallback for today's behaviour). It would make the old comment true: the whole pipeline on
  the versions PR. It loses because it puts a long-lived credential that can write to the repository in the
  repository's secrets — ADR 0014's wider blast radius, for a PR whose diff is version numbers — and because
  the gate would then stand on GitHub's policy of which tokens fire workflows: a revoked or expired token
  brings back, silently, the `action_required` with zero jobs that started this.
- **Approve the run by hand, every time.** Per run, as above, and it spends the production machine's two
  lanes (ADR 0014) on a pipeline whose diff is version numbers, with the release standing on the remembering.
- **Run the checks only when the versions PR merges**, the publish moment: the exact commit for the tarball,
  but the run happens after the mirror has already synced the commit it publishes from. A red there is a
  report, not a block. Before the PR is built is the only moment a red can still stop the number.

## Consequences

- ADR 0019's sentence that the check works in the versions PR itself is corrected; its decision — one number
  for the package and the protocol — is untouched.
- `release.yml` takes a lane for a few more minutes on the pushes that touch the published surface; those
  pushes already run the mirror's sync and `ci.yml` on `main`, on the same two lanes.
- What this does not cover: a hand edit of `changeset-release/main` after the PR is built. Nothing runs on
  that branch; the check is whoever makes it, and the operator reading the diff at the merge.
