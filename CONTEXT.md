# Placebo

Placebo measures whether a Claude Code configuration change helps, by running tasks against a frozen repo with and without the change and comparing the results with ranges. This glossary is the vocabulary used in the brief, the code, the CLI and the report.

## Language

### Experiment

**Experiment**:
One execution of a suite: every task with every arm, repeated the configured number of runs, then graded and reported.
_Avoid_: eval, benchmark, test run

**Suite**:
The versioned definition of an experiment, kept in `.placebo/`: pins, variants, tasks and graders.
_Avoid_: config, spec, eval set

**Pin**:
A value fixed in the suite or recorded in the report that must match for two results to be comparable: commit, model IDs, Claude Code version, suite hash.

**Task**:
A prompt given to the agent inside the snapshot, plus the graders that score the result.
_Avoid_: case, test case, scenario, prompt (on its own)

**Arm**:
One configuration under test in an experiment: the control or one treatment.
_Avoid_: group, condition, side

**Control**:
The arm that runs the repo exactly as it is at the pinned commit.
_Avoid_: baseline, A, "without"

**Treatment**:
An arm defined by a variant patch applied on top of the snapshot.
_Avoid_: B, candidate, "with"

**Variant patch**:
A patch file against the pinned commit that defines a treatment. It may add, edit or delete any file.
_Avoid_: overlay, overlay directory, config bundle

**Configuration surface**:
The paths a variant patch is expected to touch: `CLAUDE.md`, `AGENTS.md`, `.claude/`, hook scripts and similar. A patch outside it triggers a warning.

**Run**:
One execution of one task with one arm, from a fresh copy of the snapshot to a stored result.
_Avoid_: trial, sample, session, attempt

### Running

**Snapshot**:
The sealed, prepared copy of the repo at the pinned commit: a clean clone with no other history reachable, setup command applied, cached.
_Avoid_: frozen codebase, checkout, image, workspace

**Setup command**:
The command run once when preparing a snapshot, usually a dependency install.

**Run folder**:
The per-run copy of the snapshot, with the variant patch applied, in which the agent works. Kept after the run by default.
_Avoid_: worktree, container, sandbox (that word is reserved for the OS restriction)

**Runner**:
The port that starts the agent in a run folder and streams its events. Implementations: SDK, installed CLI, fake.
_Avoid_: driver, harness

**Executor**:
The port that prepares snapshots and run folders. Implementations: local now, Docker later.

**Change**:
The diff between the run folder after the agent finished and the snapshot plus variant patch. The variant's own files are never part of the change.
_Avoid_: diff (in prose), output, result

**Outcome**:
How a run ended: completed, failed, crashed, or stopped by a permission denial.
_Avoid_: status, exit

### Grading

**Grader**:
Anything that produces a score for a run. Deterministic graders, judge graders and reviews are all graders.
_Avoid_: scorer, evaluator, assertion

**Hidden files**:
Files injected into the run folder only after the agent has finished and before graders run; usually held-out tests.
_Avoid_: hidden held-out tests, secret tests, oracle

**Subject model**:
The model the agent runs with in every arm, pinned as a full model ID.
_Avoid_: target model, model under test

**Judge**:
A Claude Code query, one turn and tool-less by default, that answers grader questions about a result with a schema-enforced answer. Its model is pinned and differs from the subject model.
_Avoid_: LLM-as-judge, grader model, evaluator

**Checklist**:
A list of concrete yes/no questions about a result, scored as the count of yes. Answered by the judge, by reviewers, or both.
_Avoid_: rubric, criteria, scorecard

**Comparison**:
A grader that shows two results for the same task, one per arm, as `a` and `b` in random order with arms hidden, and asks which is better. Produces a win rate.
_Avoid_: pairwise, preference, head-to-head

**Review**:
A person's answers to a task's checklist for one run, or a person's comparison, stored with the reviewer's name as its own grade.
_Avoid_: HITL, annotation, override

**Reviewer**:
A person entering reviews. Several reviewers may review the same run.

**Blinding**:
Hiding which arm a result belongs to from a judge or reviewer until grading is complete.

**Dead task**:
A task on which every arm scored zero; flagged and excluded from verdicts.
_Avoid_: unsolvable task, broken task

### Statistics and verdicts

**Metric**:
One measured quantity per run, such as pass rate, cost, tokens, turns, checklist score or win rate.
_Avoid_: KPI, signal

**Score**:
A grader's output for one run.

**Difference**:
Treatment minus control for one metric, computed per task, then summarized across tasks.
_Avoid_: delta, Δ, effect, lift

**Range**:
The plausible spread of a difference given the runs done, computed by resampling. Printed next to every difference.
_Avoid_: confidence interval, CI, error bars

**Resampling**:
Simulating re-runs of the experiment by drawing at random, with replacement, from the real results; tasks first, then runs within each task.
_Avoid_: bootstrap, hierarchical bootstrap, Monte Carlo

**Margin**:
The smallest difference that would matter for a metric. A range entirely inside the margin earns the placebo verdict.
_Avoid_: equivalence margin, threshold, tolerance

**Verdict**:
The single tag on a metric row: helps, harms, placebo, or no evidence.
_Avoid_: winner, significance, result

**Runs needed**:
The estimated number of runs per task that would shrink a range enough to reach a verdict other than no evidence.

### Results

**Run store**:
The local store of runs under `.placebo/runs/`: one JSON file per run plus a SQLite index.
_Avoid_: database, results dir, cache

**Run key**:
The content hashes that identify a run for comparison: task, variant patch, commit, subject model, Claude Code version.

**Report**:
The single self-contained HTML file with the embedded results; also the terminal card and table.
_Avoid_: dashboard, UI

**Verdict card**:
The top of a report: the treatment against control, the run counts and pins, and one line per metric with difference, range and verdict.
