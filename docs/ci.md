# CI

Three workflows run on GitHub Actions.

- **CI** runs `pnpm check` and `pnpm build` on every pull request and every push to `main`, and uploads the coverage report. It needs no secret.
- **Claude Code Review** reviews every non-draft pull request against `AGENTS.md`, `CONTEXT.md` and the ADRs, and posts one comment opening with `**[REVIEW]**`: findings only, or `✅ LGTM`. It reads code and CI status but runs nothing. Drafts, Dependabot and the changesets "chore: version packages" pull request are skipped. The check fails when the model call is rejected or no finished review comment is posted; a zero-cost transient rejection is retried once first. Pull requests that modify a workflow file are skipped by the action itself.
- **Release** versions and publishes `placebo-eval`; see `docs/releasing.md`.

The review needs the Claude GitHub App installed on the repository (`claude` in Claude Code, then `/install-github-app`, or https://github.com/apps/claude) and one secret under Settings, Secrets and variables, Actions:

- `CLAUDE_CODE_OAUTH_TOKEN`: a long-lived token for Claude subscription users, printed by `claude setup-token`.
- or `ANTHROPIC_API_KEY`: an Anthropic API key, billed per token. Set only one; the workflow passes both inputs and the action uses whichever is present.

The model is pinned in the workflow, so changing it is a commit.
