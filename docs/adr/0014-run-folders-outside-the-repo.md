---
status: accepted
---
# Snapshots and run folders live outside the repository

Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from every ancestor directory of its working directory. A run folder inside the repo, such as `.placebo/folders/<id>/`, would therefore load the user's own configuration into every arm, the control included, and the experiment would compare the repo's configuration plus a variant against the repo's configuration plus the control, never against a stripped repo. Project-only settings (ADR 0004) do not help: ancestor memory files are project memory.

Snapshots and run folders therefore live under a per-repo data directory outside the repo: `~/.placebo/<repo dir name>-<first 8 hex of sha256(absolute repo path)>/`, with `snapshots/` and `folders/` inside. The name keeps the directory readable and the hash keeps two checkouts of the same name apart. The `PLACEBO_HOME` environment variable replaces `~/.placebo`. The run store (`.placebo/runs/`) and reports stay in the repo, next to the suite, because they hold results rather than working copies and nothing loads them.

A home directory can itself hold configuration. Before running, Placebo checks every directory from the folders root up to `/` for `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` or a `.claude/` directory, prints a warning naming each one, and records it in the results as an `ancestor_configuration` warning. The user's own Claude config directory (`~/.claude/`, or `CLAUDE_CONFIG_DIR`) is left out of the check: it is user settings, which project-only settings already keep out.

## Consequences

Run folders are harder to find than a folder in the repo, so every kept run records its absolute path in the run store and in `results.json`. `placebo clean` removes them. Moving or renaming the repo gives it a new data directory; the old one stays until removed by hand.
