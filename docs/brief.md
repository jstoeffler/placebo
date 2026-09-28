# Placebo — Project Brief

> **Stop cargo-culting your CLAUDE.md.**
> Placebo measures whether a change to your Claude Code configuration actually helps. It runs the same tasks many times against a frozen copy of your repo, with and without the change, and reports the difference with an honest "give or take".

**Status:** design settled on 2026-09-27 after a full design interview. Nothing is built yet. This document is the source of truth for the first version. Decisions that are hard to reverse also have a short record in `docs/adr/`. Vocabulary is defined in `CONTEXT.md` and this brief uses those terms.

---

## 1. The problem

Engineers add rules, skills, hooks and agents to `CLAUDE.md` and `.claude/` without ever checking whether they help. The files grow. Every line costs context on every task. Nobody knows which lines do anything, and some make things worse. We call this rule slop.

The published research does not settle it. One study found developer-written context files help every agent except Claude Code and that generated ones hurt, but it sampled each task once. Another found `AGENTS.md` cuts runtime and tokens. A third, over 1,650 Claude Code sessions, found file length, rule position and nesting have no measurable effect on whether rules are followed. A fourth estimated that around 120 tasks are needed to detect a ten-point effect at all. See §16 for references.

Anthropic's own guidance says: keep it concise, ask of every line "would removing this cause Claude to make mistakes? If not, cut it", treat `CLAUDE.md` like code, and "test changes by observing whether Claude's behavior actually shifts". There is no tool for that observation. Placebo is that tool.

## 2. What Placebo is

A command-line tool. Point it at a repo. It freezes the repo at a commit, runs a set of tasks with the control configuration and with each treatment, several times each, scores every run, and tells you per metric whether the treatment helps, harms, does nothing, or whether you need more runs to know. Results are stored as raw data, printed in the terminal, and written as a single self-contained HTML report that CI can keep as an artifact.

What it is not:

- Not a benchmark of models. The model is pinned; the configuration is what varies.
- Not a prompt optimizer. It measures; it does not rewrite your rules.
- Not a hosted service, for now. No server, no database service, no accounts.
- Not a replacement for `claude plugin eval`. That tool tests plugins with and without themselves in an empty workspace. Placebo tests any configuration change inside a real repo at a pinned commit, with repeats and ranges. Grader names are kept compatible where they overlap.

## 3. Goals and posture

- **Honest by construction.** Never a number without its range. Never a verdict the data cannot support. Every way an experiment can lie is written down (§13) and shown in the report where relevant.
- **Reproducible by strangers.** Every report carries its pins: commit, full model IDs, Claude Code version, suite hash. Anyone can rerun a public suite and get comparable numbers.
- **Cheap to try.** Two commands in any repo, using the Claude Code login you already have. No API key required, no infrastructure.
- **Deterministic first.** Tests before judges, judges before opinions. Humans can always overrule with a recorded review, never a silent edit.
- **Built to be studied.** Results are keyed by content so runs from different experiments and machines can be pooled. The launch includes a published study of popular `CLAUDE.md` advice with reproducible suites, so the claims can be checked and extended by others.
- **Small and inspectable.** TypeScript, three packages, no services. A reader can follow one run end to end in an afternoon.
- **Dogfooded.** Placebo's own `AGENTS.md` is evaluated with Placebo. Rules that show no effect are deleted.

## 4. Who it is for, in order

1. A developer who wants to know whether their own `CLAUDE.md`, or one rule they are about to add, does anything.
2. A team that wants a pull request touching `CLAUDE.md` or `.claude/` to carry evidence. A GitHub Action comes later.
3. People studying agent configuration who need a rigorous local harness and a shared results format.

## 5. First run

```
npx placebo-eval init     # creates .placebo/, pins models, writes none.patch
placebo run               # repo as-is vs stripped, 5 runs per task per arm
```

`init` detects the repo and its HEAD commit, resolves your current Claude Code default model and the current Opus to full model IDs and writes them into the suite, generates `variants/none.patch` which deletes `CLAUDE.md`, `AGENTS.md` and `.claude/`, detects a setup command from the lockfile, and scaffolds one example task. Tasks are hand-written in v0.1. Mining tasks from git history is the next milestone.

`run` prints a verdict card and a table, and writes the report. Example card:

```
none vs control            5 runs × 3 tasks    model claude-sonnet-5    claude code 2.1.283
  pass rate     -7 pts    [-30, +15]     no evidence   (≈12 runs/task to decide)
  cost          -18 %     [-24, -12]     helps
  tokens in     -21 %     [-27, -15]     helps
  turns         -1.2      [-2.6, +0.3]   no evidence
  checklist     -0.4      [-1.1, +0.2]   no evidence
```

The headline question of the first run is "is your CLAUDE.md a placebo?". The same flow with a treatment patch that adds one rule answers "does this rule help?".

## 6. Experiment design

**Suite.** Lives in `.placebo/`: `suite.yaml`, `variants/` with patch files, `tasks/` with hidden files and checklists. The suite pins: repo (defaults to this repo), commit (written explicitly by `init`), subject model, judge model, runs per task per arm (default 5), parallelism (default 4), setup command. The Claude Code version is recorded at run time. The suite is reviewed like code.

**Tasks.** Each has an id, a prompt, graders, and optionally checklist questions and hidden files. The prompt is sent to the agent bare, with no wrapper. Authors may add a "must keep working" line naming functions or entry points the hidden tests call, so an agent that rewrites internals does not fail for renaming things.

**Variants.** Control is the repo as-is at the commit. Each treatment is a patch file applied on top of the snapshot before the run. A patch can add, edit or delete anything: `CLAUDE.md`, rules, skills, agents, hooks, settings, a `CONTEXT.md`. When a patch touches files outside the configuration surface, Placebo warns and proceeds, so testing whether an architecture doc helps is allowed but never accidental. `none.patch` is generated. Ablation, which generates one patch per section of a file so each section is tested by its absence, comes later.

**Runs.** Five per task per arm by default. Runs from all arms are interleaved in random order so rate limits and time of day hit every arm equally.

**No limits by default.** No turn cap, no cost cap, no time cap. In practice these stop the tool from working more often than they save money. All three exist as opt-in suite settings. Retries happen only for infrastructure errors such as a failed process spawn or a rate-limit response after backoff, never for the agent's own behavior.

## 7. Running a run

**Snapshot.** A clean clone of the pinned commit, sealed so no later commits or other refs are reachable, because an agent with `git log` access can otherwise find hints or the real fix. The setup command runs once. The result is cached by commit and setup-command hash. Untracked and ignored files from the working tree never enter a snapshot, so local secrets never reach a run.

**Per run.** Copy the snapshot using copy-on-write where the filesystem supports it (APFS on macOS, Btrfs or XFS with reflinks on Linux), a full copy otherwise, since ext4 and Docker Desktop mounts cannot clone. Apply the variant patch. Spawn the agent in that folder. Capture every event. Compute the change as the diff against snapshot plus patch, so the variant's own config files are never part of the measured change. Inject hidden files. Run graders. Store the run.

**Runner.** The Claude Agent SDK by default. It bundles its own Claude Code binary at the same version as the SDK package, so pinning the package pins Claude Code, and it yields typed events with usage and cost. A fallback runner drives the user's installed `claude` in print mode with streamed JSON and records `claude --version`.

**Auth.** Placebo offers no login flow and requires no API key. It spawns Claude Code on the user's machine, which uses whatever login is already there: subscription, API key, Bedrock, Vertex or Foundry. Anthropic's policy forbids third-party products from offering claude.ai login; Placebo offers none. Whether running experiments on a subscription fits the user's plan terms is the user's call, and the README says so plainly and points CI users to API keys.

**Isolation.** Only project settings load, so nothing from the user's personal settings, personal `CLAUDE.md` or rules enters a run. Strict MCP config keeps personal MCP servers out. Each run's unique folder means Claude's auto-memory starts empty and is never shared. Residual leaks that this design does not close, and which a temp HOME would close at the cost of subscription auth: the global config file, managed policy settings, and claude.ai connectors. They are documented in §13.

**Background work.** Every unit of work the agent causes is measured, or it cannot happen. Subject runs turn Claude Code's background execution off, so a subagent or a shell command finishes before the turn that started it, and they cannot use tools whose effects escape the run folder or the measurement: scheduling, notifications, remote triggers, worktrees, workflows and messages to other sessions. A suite that needs background work sets `background_work: true` and gets a warning. `docs/measurement.md` records the facts this rests on.

**Sandbox.** Claude Code's built-in sandbox is on, confining writes to the run folder and hiding HOME, with permissions bypassed inside it so runs never block on a prompt. Network stays allowed because agents install packages. A flag disables the sandbox for repos that need it.

## 8. What is measured per run

- Tokens: input, output, cache read, cache write, reported separately because cache skews cost.
- Cost in USD as reported by the SDK, also on subscriptions as an estimate; usage streamed after its last result is priced at the rates it implies, and the cost is marked as estimated.
- Turns of the main loop and of subagents, wall-clock duration from start to exit next to the duration Claude Code reports, API duration. Subagents' tokens and tool calls count with the main loop's.
- Tool calls, total and per tool. Files read and bytes read. Search calls, as a measure of exploration effort.
- Size of the change and files touched.
- Outcome: completed, failed, crashed, or stopped by a permission denial.
- Grader results, judge results, and human reviews.

## 9. Grading

In order of trust.

**Deterministic graders.** A command that must exit zero, with hidden files injected before it runs, which is how hidden tests work. File exists or modified. Regex on the change. Tool used. Names follow `claude plugin eval` where they overlap.

**Judge graders.** Two kinds. A checklist: concrete yes/no questions about the result, scored as the count of yes. A comparison: two results for the same task, one per arm, shown as `a` and `b` in random order with the arm hidden, and the judge picks the better one with a reason. For each task, every treatment run is paired with a random control run, and the treatment's win rate is a metric like any other. Judges run as one-turn, tool-less Claude Code queries with a JSON schema enforcing the answer, so they work with any auth and cost a fraction of a run. An agentic judge that explores a config-stripped copy of the result is available per grader for questions like "did it duplicate an existing helper?". The judge model is pinned and must differ from the subject model; a warning fires otherwise. Repeating judge calls is configurable.

**Human review.** The same questions, answered by people. `placebo review` serves the report locally with a review mode and a queue of unreviewed runs. Reviewers do not see which arm a run belongs to until the pass is complete, and comparisons appear in random order. Several people can review the same run; each answer is stored with the reviewer's name, and the report shows agreement between reviewers and between reviewers and the judge. A human answer is its own grade next to the test and judge results. It never overwrites them.

**Brittle hidden tests.** An agent may fix a bug a better way and still fail a test coupled to the old implementation. Tests stay strict. Every failure shows its output next to the change so a human can see when the fix was actually fine and record that in a review. Automatic labeling of such failures by the judge is deferred until they prove common. A task where every arm scores zero is flagged as unsolvable or brittle and excluded from verdicts with a note.

## 10. Statistics and verdicts

For each metric, the difference between treatment and control is computed task by task, then summarized with a range. The range is computed by resampling: the tool simulates re-running the experiment a thousand times by drawing at random, with replacement, from the real results of each arm, and reads off how much the difference moves. The simulations cost nothing and change nothing about the estimate. They only add the honest "give or take" that a single result cannot show. With several tasks, tasks are drawn first and then runs within each task, so one odd task cannot dominate.

Every metric row gets exactly one verdict:

| Verdict | Meaning |
|---|---|
| helps | the whole range is on the good side of zero |
| harms | the whole range is on the bad side of zero |
| placebo | the whole range sits inside the margin around zero |
| no evidence | the range crosses zero and reaches beyond the margin; too few runs to say |

Default margins, overridable per suite: five percentage points for pass rate, ten percent for cost and tokens, fifteen percent for duration. The word placebo is only used when the data supports an equivalence claim; "no evidence" is not the same thing. Every "no evidence" row prints how many runs per task would likely be needed to decide. A task counts toward a metric only when each arm it compares has at least two runs with a value, since a single run gives a range that is a point; a row whose tasks all fall short says so instead of printing an estimate, and the card names every task a row leaves out.

The card leads with pass rate and cost by convention, and shows all other metrics below. The tool never declares an overall winner. Trade-offs like "more passes at more tokens" are for the human to make, and they are visible at a glance. With fewer than about five tasks, the report says the result describes these tasks, not the repo in general.

## 11. Results, reports, artifacts

**Run store.** One JSON file per run under `.placebo/runs/`, plus a SQLite index, both gitignored. Each run is keyed by content hashes of the task, the variant patch, the commit, the model and the Claude Code version. Two runs sharing those keys are comparable no matter which experiment or machine produced them. A later `placebo compare` command pulls any two variants from history, so testing A against B today and A against C tomorrow also yields B against C.

**Artifacts.** `report.html`, a single file with the React report and the data embedded, and `results.json` with the same rows, both meant to be stored by CI. The terminal prints the same card and table so CI logs read without opening anything. `placebo run` exits zero on completion regardless of verdicts; gating semantics arrive with the GitHub Action.

**Report contents.** v0.1: verdict card, per-metric table with ranges and verdicts, per-task breakdown, per-run list with a transcript viewer showing the timeline of tool calls, and test output next to each change. Next: distribution charts and a side-by-side diff viewer.

**Run folders.** Kept after the run by default so a human can open the result and run the app. Options: keep only runs of tasks that have review questions, or delete after grading. `placebo clean` reclaims disk.

## 12. Command surface, v0.1

| Command | Does |
|---|---|
| `placebo init` | create `.placebo/`, pin models and commit, generate `none.patch`, scaffold a task |
| `placebo run` | run the suite, print card and table, write report and results |
| `placebo review` | serve the report locally with blinded review mode |
| `placebo report` | regenerate the HTML report from the run store |
| `placebo clean` | remove kept run folders |
| `placebo compare` | next: compare any two variants from the run store |

## 13. How experiments lie

Maintained as a README section. The tool shows these where it can detect them.

1. Personal configuration leaking into every arm. Closed by project-only settings, strict MCP config and unique run folders. Residual: global config file, managed settings, claude.ai connectors.
2. The model changing under you. Closed by full model IDs in the suite and the Claude Code version in every report. A new model invalidates old baselines; rerun control.
3. Tasks that never exercise the rule. A rule about validators shows nothing on a task without validation. Each rule needs tasks that touch it and a few that do not, to catch the context cost.
4. Too few runs. Agent runs vary a lot. Three runs detect only large effects. The range and the "runs needed" line exist for this, and the report warns below three runs per task.
5. Too few tasks. Results generalize to the tasks you ran, not to your repo. The report says so under five tasks.
6. Brittle hidden tests. See §9.
7. Judge self-preference and position bias. Closed by a different judge model, hidden arms, and random order.
8. The variant influencing its own evaluation. Closed by computing the change against snapshot plus patch and by stripping config from the agentic judge's view.
9. Rate limits and time of day. Closed by interleaving arms in random order.
10. Reading a single number. Closed by never printing one without its range, and by per-metric verdicts with no overall winner.
11. Work that escapes the measurement. A subagent started in the background keeps editing the run folder after Claude Code reports its result, so the change includes work whose tokens, cost, turns and transcript the run never recorded. Closed by turning background execution off in subject runs, disallowing tools that schedule, notify, trigger remote work, fan out workflows or reach other sessions, reading the stream until Claude Code exits, measuring duration by wall clock, and counting every subagent's turns, tokens and tool calls. Residual: subagents stream provisional output tokens, so only the run's total is exact, not its split between subagents; with `background_work: true`, work still running at exit is lost and cost after the last result is an estimate, marked ≈.

## 14. Engineering

**Stack.** TypeScript everywhere, pnpm workspace, Node 26, Zod at every edge, Vitest.

**Packages.** `core` is framework-free and holds the domain, ports, commands, graders and statistics. `cli` wires core to the local executor, the SDK runner and SQLite. `report` is the React single-file report. Adapters live inside core behind ports until a second implementation of a port exists; then they split out. Ports with real seams: Executor (local now, Docker later), Runner (SDK, installed CLI, and a fake deterministic runner so tests cost zero tokens), RunStore (SQLite now, Postgres if a server ever exists).

**Dependency rules.** Domain imports nothing but the shared kernel. Commands import only their own domain and ports. Core never imports the SDK, SQLite or React. Apps only wire. No cycles.

**Enforcement, minimal now.** Strict TypeScript, typed ESLint, dependency-cruiser with the rules above, Knip for dead code, one PostToolUse hook that lints and typechecks touched files, a root `AGENTS.md` with `CLAUDE.md` importing it. The local ESLint plugin, generators and the baseline ratchet are added the first time a real recurring violation appears, which is the ratchet rule applied to itself: every convention is either mechanically enforced or explicitly labeled as judgment, and prose is the last resort.

**Testing.** Static checks first. Unit tests for the domain and statistics. Integration tests for each command against the fake runner and in-memory store. One end-to-end test that runs a tiny suite with the fake runner on Placebo's own repo and asserts the report.

**Verified versions on 2026-09-27.** Claude Code 2.1.283, `@anthropic-ai/claude-agent-sdk` 0.3.283, Node 26.5, pnpm 10.11, Docker 28.

## 15. Verified facts about the Agent SDK

Checked against the published type definitions of `@anthropic-ai/claude-agent-sdk` 0.3.283 and the current docs on 2026-09-27.

- `settingSources` accepts `user`, `project`, `local`. Omitted means all. `[]` is isolation mode. `project` must be present for `CLAUDE.md` to load.
- `sandbox` is a first-class query option with `enabled`, `network.allowedDomains`, `allowUnsandboxedCommands` and more. `settings` accepts an inline object. `managedSettings` exists for restrictive policy.
- `permissionMode: 'bypassPermissions'` requires `allowDangerouslySkipPermissions: true`. A `dontAsk` mode silently denies non-allowlisted tools.
- `outputFormat: { type: 'json_schema', schema }` enforces the final answer; the result carries `structured_output`. The CLI equivalent is `--json-schema`.
- The result message carries `total_cost_usd`, `usage` with input, output, cache read and cache creation tokens, `modelUsage` per model, `num_turns`, `duration_ms`, `duration_api_ms`, `permission_denials`, `terminal_reason` and `stop_reason`. Each assistant message carries its own `usage`, so per-turn attribution works.
- `maxTurns`, `maxBudgetUsd` and `fallbackModel` exist. All are opt-in in Placebo.
- `pathToClaudeCodeExecutable` overrides the bundled binary. The bundled binary ships as a platform package at the same version as the SDK.
- Credentials live in the macOS keychain or `~/.claude/.credentials.json`, relocatable with `CLAUDE_CONFIG_DIR`. A fresh config dir therefore drops subscription auth, which is why Placebo does not use one.
- Things that load regardless of `settingSources`: managed policy settings, `~/.claude.json`, auto-memory keyed by project path, claude.ai connectors.
- `claude plugin eval`: cases are a directory with `prompt.md` frontmatter; graders regex, tool_used, tool_order, file_exists, llm, baseline; flags `--runs`, `--concurrency`, `--model`, `--judge-model`, `--threshold`, `--max-cost-usd`, `--ablation none|with-without`, `--no-publish`, `--json`. Plugin-only, temp HOME, no commit pinning, no ranges.

## 16. Prior art and positioning

Nothing combines four things: real Claude Code sessions with the full configuration surface, a frozen repo at a pinned commit with hidden tests, repeats with ranges and a paired design, and cost per arm. Findings from web research on 2026-09-27; re-verify star counts and claims before quoting them publicly.

| Project | What it does | Gap |
|---|---|---|
| skillcheck | blind A/B of rules files with bootstrap ranges and a HELPS / PLACEBO / HARMS verdict | injects the file as a system prompt to the raw API; no real agent, no repo, no tests |
| claude-bakeoff | two CLAUDE.md environments judged 1 to 10 | one run each, no ranges, no tests |
| evalfloor | `claude -p` cohorts with bootstrap ranges on cost | no correctness grading; compares CLI options |
| plzebo | cost per successful outcome across arms | model mix focus, not config; near-name collision |
| `claude plugin eval` | with/without a plugin, six graders, temp HOME | plugin-only, excludes CLAUDE.md and hooks, three runs, no ranges |
| agentbench-local, agenthangar/evals | mine tasks from merged PRs, sealed workspace, hidden PR tests | compare agents, not configs; no statistics |
| harness-evaluator | harness × model × task matrix with bootstrap ranges | compares harnesses, not configs |
| Harbor / Terminal-Bench, promptfoo, Inspect AI | general eval infrastructure | no config ablation, no repo snapshotting |

Studies to cite, with arXiv IDs as found: Gloaguen et al., "Evaluating AGENTS.md" (2602.11988), single sample per task; Lulla et al., "On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents" (2601.20404); Khatri, "Do Context Files Help Coding Agents? A Two-Agent Ablation Study" (2607.27250), task-clustered bootstrap and equivalence testing; McMillan, "Instruction Adherence in Coding Agent Configuration Files: A Factorial Study" (2605.10039). Anthropic pages: Claude Code best practices, the costs page's "aim to keep CLAUDE.md under 200 lines", and "Effective context engineering for AI agents".

## 17. Naming and distribution

- Name: Placebo. Handle everywhere: `placebo-eval`. npm package `placebo-eval` with binary `placebo`. GitHub organization `placebo-eval` is free at the time of writing.
- The bare npm name `placebo` has been an empty placeholder since 2013. npm does not transfer squatted names on request, so the route is to email the owner. `@placebo` is an existing org and unavailable.
- Domains free at the time of writing: placebo.sh, placebo.run, placebo-eval.dev. placebo.dev is parked for sale.
- Known collisions to acknowledge in the README: a boto3 mocking library named placebo on PyPI, `plzebo` on npm, and skillcheck's use of PLACEBO as a verdict label.

## 18. Roadmap

**v0.1, the vertical slice.** init, run, review, report, clean. Local executor with sealed snapshots and copy-on-write. SDK runner with CLI fallback and the fake runner. Deterministic, checklist and comparison graders. Human review. Statistics and the four verdicts. Run store with content keys. Single-file HTML report. Dogfooded on the author's repos and on Placebo itself.

**Next.** Distribution charts and diff viewer. Task mining from git history: parent commit as snapshot, commit message as prompt with optional LLM rewrite kept under review, tests from the commit as hidden tests, validation that they fail before and pass after the original change. Ablation of `CLAUDE.md` sections. `placebo compare`. Judge repeats.

**Then.** GitHub Action with gating semantics. The published study of popular `CLAUDE.md` advice on public repos, with reproducible suites and reports. Judge labeling of brittle test failures if they prove common. Docker executor for arbitrary stacks and CI. Importing `claude plugin eval` suites. A server mode reusing the report components, only if the CLI has users who need it. Model as a matrix dimension.

## 19. Deferred decisions

Each of these gets its own design interview before it is built: mining details and prompt rewriting; ablation granularity; Action gating rules and exit codes; study design and budget; Docker image strategy; server data model; a `placebo variant capture` command that turns uncommitted config edits into a patch.

## Appendix A: example suite

```yaml
# .placebo/suite.yaml
repo: .
commit: 3f9a1c2e
model: claude-sonnet-5            # written by init from your current default
judge_model: claude-opus-5-5      # written by init from the current Opus
runs: 5
parallelism: 4
setup: pnpm install --frozen-lockfile

variants:
  none:   { patch: variants/none.patch }
  tests:  { patch: variants/always-run-tests.patch }

tasks:
  - id: refund-rounding
    prompt: |
      Refunds of 10.005 are rounded to 10.00 instead of 10.01.
      Fix the rounding. `refund(amount)` in src/money.ts must keep its signature.
    graders:
      - { type: command, run: "pnpm vitest run tests/hidden/refund.spec.ts", hidden: [tests/hidden/refund.spec.ts] }
      - { type: file_modified, path: src/money.ts }
      - { type: checklist, questions: tasks/refund-rounding/checklist.md }
      - { type: comparison }
    review:
      questions: tasks/refund-rounding/checklist.md
```

## Appendix B: what a report must let a reader do

Read the verdict card in ten seconds. See every metric with its range and verdict. Open any task and see per-arm results. Open any run and replay its tool calls in order, read the change, read the test output, read the judge's reasoning. Enter a blinded human review. Find the pins that make the report reproducible.
