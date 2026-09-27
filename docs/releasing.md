# Releasing

Only `placebo-eval` (packages/cli) is published; `@placebo-eval/core` and `@placebo-eval/report` are private and bundled into it.

1. A pull request that should appear in the changelog adds a changeset: `pnpm changeset`, pick `placebo-eval`, write one line for users. Before 0.1.0, feature work adds none; the first changeset is written at release time.
2. On every push to `main`, `.github/workflows/release.yml` runs `pnpm check`, then the changesets action opens or updates a "chore: version packages" pull request that bumps the version and writes `CHANGELOG.md`.
3. Merging that pull request publishes `placebo-eval` to npm with provenance (`pnpm release` builds, then runs `changeset publish`) and pushes the git tag.

The maintainer sets one secret: `NPM_TOKEN`, an npm automation token with publish rights on `placebo-eval`, under the repository's Settings, Secrets and variables, Actions. `GITHUB_TOKEN` is provided by GitHub; allow Actions to create pull requests in Settings, Actions, General.
