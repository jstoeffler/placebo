# Releasing

Only `placebo-eval` (packages/cli) is published; `@placebo-eval/core` and `@placebo-eval/report` are private and bundled into it.

1. A pull request that should appear in the changelog adds a changeset: `pnpm changeset`, pick `placebo-eval`, write one line for users. Before 0.1.0, feature work adds none; the first changeset is written at release time.
2. On every push to `main`, `.github/workflows/release.yml` runs `pnpm check`, then the changesets action opens or updates a "chore: version packages" pull request that bumps the version and writes `CHANGELOG.md`.
3. Merging that pull request publishes `placebo-eval` to npm with provenance (`pnpm release` builds, then runs `changeset publish`), pushes the git tag and creates a GitHub Release.

The workflow uses `changesets/action@v2` and was checked against its v2.1.2 input set: `github-token`, `publish-script`, `version-script`, `commit-message`, `pr-title`, `pr-draft`, `pr-base-branch`, `create-github-releases`, `push-git-tags`, `push-with-git-cli`, `cwd`. The action no longer writes `.npmrc` from `NPM_TOKEN`; `actions/setup-node` with `registry-url` does.

## npm authentication

The workflow publishes with the `NPM_TOKEN` secret when it is set, and through npm Trusted Publishing (OIDC, no stored token, provenance automatic) when it is not. npm is deprecating tokens that bypass two-factor authentication for direct publishing in January 2027, so the token is only a bootstrap.

1. First publish: `NPM_TOKEN` holds an npm automation token with publish rights, under Settings, Secrets and variables, Actions.
2. Once `placebo-eval` exists on npm, open its Settings page on npmjs.com, add a trusted publisher: GitHub Actions, organization or user `jstoeffler`, repository `placebo`, workflow filename `release.yml`, environment blank, and allow direct publishing with `npm publish` (new configurations allow only `npm stage publish` by default).
3. Delete the token on npmjs.com and the `NPM_TOKEN` secret on GitHub. The next release uses OIDC; the job needs `id-token: write` and npm 11.5.1 or later, both already in the workflow.

`GITHUB_TOKEN` is provided by GitHub; allow Actions to create pull requests in Settings, Actions, General.
