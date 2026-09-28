---
'placebo-eval': minor
---

First release: Placebo measures whether a change to your Claude Code configuration actually helps.

- `placebo init` pins the commit, the subject and judge models and a setup command in `.placebo/suite.yaml`, writes `variants/none.patch` (your repo without `CLAUDE.md`, `AGENTS.md` and `.claude/`) and scaffolds an example task.
- `placebo run` runs every task under control and each treatment, several times in random interleaved order, each run in a fresh copy of a sealed snapshot of the pinned commit; it prints a verdict card and a per-task table and writes `report.html` and `results.json`.
- Agents run through the Claude Agent SDK, or your installed `claude` with `--runner cli`, on the login you already have.
- Runs are graded by deterministic graders first (a command with hidden files, file exists or modified, regex, tool used), then by a judge on a different model answering checklists and blinded comparisons.
- Every metric shows its difference with a range from resampling and one of four verdicts (helps, harms, placebo, no evidence), plus the runs per task likely needed when there is no evidence.
- `placebo review` serves the report for blinded human reviews, `placebo report` regenerates it from the run store, and `placebo clean` removes kept run folders and snapshots.
- Runs are stored keyed by the content of their task, variant patch, commit, model and Claude Code version, so results from different experiments stay comparable.
