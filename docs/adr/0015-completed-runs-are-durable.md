---
status: accepted
---
# Completed runs are durable, so an interrupted experiment can be resumed

An experiment can take hours and cost real money, and it can stop part way: Ctrl-C, a rate limit that outlasts the retries, an expired login, a laptop going to sleep. Throwing away what finished would waste that spend. So every run is saved the moment it is graded, with its content-addressed run key (ADR 0006), and a run that did not finish is never saved: a run cut short by the abort signal is discarded, not stored as `failed`, because it says nothing about the arm.

An interrupted experiment therefore keeps every run it completed, and `placebo report` works on it: the results cover the runs that exist, with ranges as wide as that data warrants. Comparisons, which need every run of a task, are the only step missing.

Nothing about the plan lives only in memory. The experiment is saved before its first run with its seed, tasks, arms and runs per task; the slots, their run ids, their order and each slot's seed are derived from those alone. A later `placebo run --resume <experiment>` can rebuild the same plan, skip every slot whose run is in the store with a matching run key, perform the rest, then run the comparisons and assemble the results as if the experiment had never stopped.

## Consequences

Resume is not built yet; this records why it stays cheap to add. The plan must remain a pure function of the saved experiment, and saving a run must remain the last step of performing it. A resume refuses to fill slots when the pins no longer match (suite hash, commit, models or Claude Code version), since the new runs would not be comparable with the old ones.
