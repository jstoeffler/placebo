# Releasing

Only `placebo-eval` (packages/cli) is published; `@placebo-eval/core` and `@placebo-eval/report` are private and bundled into it.

1. A pull request that should appear in the changelog adds a changeset: `pnpm changeset`, pick `placebo-eval`, write one line for users. Before 0.1.0, feature work adds none; the first changeset is written at release time.
2. On every push to `main`, `.github/workflows/release.yml` runs `pnpm check`, then the changesets action opens or updates a "chore: version packages" pull request that bumps the version and writes `CHANGELOG.md`.
3. Merging that pull request publishes `placebo-eval` to npm with provenance, pushes the git tag and creates a GitHub Release.

The action runs `pnpm release` whenever no changeset is pending, not only after a version bump. `pnpm release` runs `scripts/release.ts`: while `packages/cli/package.json` says `0.0.0` it prints "nothing to release: version is 0.0.0" and exits 0; otherwise it builds, then runs `changeset publish`, which publishes only versions npm does not have yet.

The workflow uses `changesets/action@v2` and was checked against its v2.1.2 input set: `github-token`, `publish-script`, `version-script`, `commit-message`, `pr-title`, `pr-draft`, `pr-base-branch`, `create-github-releases`, `push-git-tags`, `push-with-git-cli`, `cwd`. The action no longer writes `.npmrc` from `NPM_TOKEN`; `actions/setup-node` with `registry-url` does.

## npm authentication

The workflow publishes with the `NPM_TOKEN` secret when it is set, and through npm Trusted Publishing (OIDC, no stored token, provenance automatic) when it is not. Trusted Publishing can only be configured for a package that already exists on npm, and the maintainer's token is a stage-only token that npm refuses for direct publishing, so the first version is published by hand, once.

1. First publish of 0.1.0, from the maintainer's machine, before merging the "chore: version packages" pull request that bumps to 0.1.0: check out its branch, run `pnpm install`, `npm login`, `pnpm build`, then `pnpm --filter placebo-eval publish --access public --no-provenance`, entering the one-time code npm asks for. Provenance is only possible from CI, which is why the manual publish turns it off; the workflow adds it on every later release.
2. On npmjs.com, open the Settings page of `placebo-eval` and add a trusted publisher: GitHub Actions, repository `jstoeffler/placebo`, workflow filename `release.yml`, environment blank, and tick direct publishing with `npm publish` (new configurations allow only `npm stage publish` by default).
3. Delete the `NPM_TOKEN` secret on GitHub (Settings, Secrets and variables, Actions).
4. Merge the pull request. `changeset publish` finds 0.1.0 already on npm and skips it, so the workflow tags nothing: push the tag `placebo-eval@0.1.0` and create its GitHub Release by hand.

From then on the workflow publishes through OIDC with provenance and no token; the job needs `id-token: write` and npm 11.5.1 or later, both already in the workflow.

`GITHUB_TOKEN` is provided by GitHub; allow Actions to create pull requests in Settings, Actions, General.
