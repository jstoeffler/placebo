---
status: accepted
---
# The variant patch is amended into the snapshot's single commit

For each run the executor applies the variant patch, then runs `git add -A && git commit --amend --no-edit` with the original author and committer dates, so the run folder has exactly one commit with the original message. An agent running `git log` or `git diff` sees no "variant" commit and cannot tell which arm it is in, and the change is simply `git diff HEAD` plus untracked files, which excludes the variant's own files by construction. The control arm goes through the same amend with no patch, so both arms differ only in content, never in commit ids produced by different steps.

## Consequences

The commit id in the run folder differs from the pinned commit for treatments. The run key uses the pinned commit, not the amended one.
