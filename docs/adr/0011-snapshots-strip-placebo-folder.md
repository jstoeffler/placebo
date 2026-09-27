---
status: accepted
---
# Snapshots delete `.placebo/` after checkout

The suite lives in the repo under `.placebo/`, so a clone of the pinned commit would carry the tasks, the hidden files and the checklists into every run folder, where the agent could read the answers. The snapshot deletes `.placebo/` right after checkout and before the setup command. The agent never sees the suite, and `.placebo/` is never part of a variant patch or of the measured change.

## Consequences

A variant patch touching `.placebo/` is rejected rather than applied. Hidden files are copied in from the suite by the executor only after the agent finished.
