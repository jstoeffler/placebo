# Placebo

**Stop cargo-culting your CLAUDE.md.**

Placebo measures whether a change to your Claude Code configuration actually helps. It runs the same tasks many times against a frozen copy of your repo, with and without the change, and reports the difference with an honest "give or take".

**Status:** 0.1.0 is not yet published. `init`, `run`, `report` and `clean` work from source; `review` is not built yet.

## First run

Once 0.1.0 is published, in the repo whose configuration you want to test:

```
npx placebo-eval init     # creates .placebo/, pins models and HEAD, writes none.patch
npx placebo-eval run      # repo as-is vs stripped, 5 runs per task per arm
```

Until then, build it from a clone of this repo (`pnpm install && pnpm build`) and run `node <clone>/packages/cli/bin/placebo.js` in place of `npx placebo-eval`.

`init` detects the repo and its HEAD commit, asks Claude Code for your current default model and the current Opus and pins them as full model IDs (`--model <id>` and `--judge-model <id>` skip the question), generates `variants/none.patch` which deletes every tracked `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/` and `.mcp.json`, detects a setup command from the lockfile, and scaffolds one example task. Commit the suite and review it like code.

`run --runs 1` is a cheap first pass that checks the suite end to end. `run` then prints a verdict card per treatment and a per-task table, and writes `report.html` and `results.json` under `.placebo/reports/<experiment id>/`:

```
none vs control            5 runs × 3 tasks    model claude-sonnet-5    claude code 2.1.283
  pass rate     -7 pts    [-30, +15]     no evidence   (≈12 runs/task to decide)
  cost          -18 %     [-24, -12]     helps
  tokens in     -21 %     [-27, -15]     helps
  turns         -1.2      [-2.6, +0.3]   no evidence   (≈20 runs/task to decide)
  checklist     -0.4      [-1.1, +0.2]   no evidence   (≈30 runs/task to decide)
```

It exits 0 once the experiment completes, whatever the verdicts, 1 when the experiment ends early (the runs done so far stay in the run store), and 2 on a usage error. Ctrl-C stops after the runs in flight; a second Ctrl-C exits at once.

The first run asks "is your CLAUDE.md a placebo?". The same flow with a treatment patch that adds one rule asks "does this rule help?".

## Commands

| Command | Does |
| --- | --- |
| `placebo init [--model <id>] [--judge-model <id>] [--force]` | create `.placebo/`, pin models and commit, generate `none.patch`, scaffold a task |
| `placebo run [--runs <n>] [--parallelism <n>] [--task <id>] [--variant <name>] [--keep all\|reviewable\|none] [--seed <n>] [--runner sdk\|cli] [--sandbox\|--no-sandbox] [--out <dir>] [--suite <dir>] [--no-color] [--quiet]` | run the suite, print card and table, write report and results |
| `placebo report [experiment] [--out <dir>] [--suite <dir>]` | regenerate the HTML report from the run store, the newest experiment by default |
| `placebo clean [--experiment <id>] [--snapshots] [--dry-run]` | remove kept run folders |
| `placebo review` | serve the report locally with blinded review mode (not built yet) |

`placebo <command> --help` describes every flag.

Snapshots and run folders live outside the repo, under `~/.placebo/<repo>-<hash>/` (or `$PLACEBO_HOME`), because Claude Code loads `CLAUDE.md` from every directory above the one it runs in, and a run folder inside the repo would load your own configuration into every arm ([ADR 0014](docs/adr/0014-run-folders-outside-the-repo.md)). The run store and reports stay in the repo, in `.placebo/runs/` and `.placebo/reports/`, which `init` keeps out of git.

## How it works

1. **Snapshot.** A sealed clone of the pinned commit, with no other history reachable and the setup command applied once.
2. **Run.** For every task and every arm, several times in random interleaved order: copy the snapshot, apply the variant patch, start Claude Code with project settings only, capture every event, and compute the change the agent made.
3. **Grade.** Hidden tests and other deterministic graders first, then a judge on a different model answering checklists and blinded comparisons, then optional human reviews.
4. **Range.** For each metric, the difference between treatment and control, task by task, with a range from resampling the real runs.
5. **Verdict.** Each metric gets one of: helps, harms, placebo (the whole range sits inside the margin), or no evidence (too few runs to say). There is never an overall winner.

## How experiments lie

1. Personal configuration leaking into every arm. Closed by project-only settings, strict MCP config and unique run folders. Residual: global config file, managed settings, claude.ai connectors.
2. The model changing under you. Closed by full model IDs in the suite and the Claude Code version in every report. A new model invalidates old baselines; rerun control.
3. Tasks that never exercise the rule. A rule about validators shows nothing on a task without validation. Each rule needs tasks that touch it and a few that do not, to catch the context cost.
4. Too few runs. Agent runs vary a lot. Three runs detect only large effects. The range and the "runs needed" line exist for this.
5. Too few tasks. Results generalize to the tasks you ran, not to your repo. The report says so under five tasks.
6. Brittle hidden tests. See §9.
7. Judge self-preference and position bias. Closed by a different judge model, hidden arms, and random order.
8. The variant influencing its own evaluation. Closed by computing the change against snapshot plus patch and by stripping config from the agentic judge's view.
9. Rate limits and time of day. Closed by interleaving arms in random order.
10. Reading a single number. Closed by never printing one without its range, and by per-metric verdicts with no overall winner.

(§9 refers to [the brief](docs/brief.md#9-grading): an agent may fix a bug a better way and still fail a test coupled to the old implementation, so every failure shows its output next to the change for a human to judge.)

## Auth

Placebo offers no login flow and requires no API key. It spawns Claude Code on your machine, which uses whatever login is already there: subscription, API key, Bedrock, Vertex or Foundry. Anthropic's policy forbids third-party products from offering claude.ai login; Placebo offers none. Whether running experiments on a subscription fits your plan's terms is your call. For CI, use an API key.

## Positioning

Other tools each cover part of this: blind A/B of rules files with ranges but no real agent or repo (skillcheck), one-shot judged comparisons (claude-bakeoff), cost ranges without correctness grading (evalfloor), task mining and sealed workspaces that compare agents rather than configurations (agentbench-local), and general eval infrastructure without configuration ablation (Harbor, promptfoo, Inspect AI). Placebo combines real Claude Code sessions with the full configuration surface, a frozen repo at a pinned commit with hidden tests, repeats with ranges and a paired design, and cost per arm. It is not a replacement for `claude plugin eval`: that tool tests plugins with and without themselves in an empty workspace, while Placebo tests any configuration change inside a real repo at a pinned commit, with repeats and ranges, and keeps grader names compatible where they overlap.

Not to be confused with the boto3 mocking library `placebo` on PyPI or `plzebo` on npm; skillcheck also uses PLACEBO as a verdict label.

## Contributing

Read [AGENTS.md](AGENTS.md), [CONTEXT.md](CONTEXT.md) and [the brief](docs/brief.md). Run `pnpm install` and `pnpm check` on Node 26.

## License

MIT
