---
status: accepted
---
# Runs are keyed by content hashes so experiments compare across time and machines

Every stored run carries hashes of its task, variant patch, commit, subject model and Claude Code version. Runs sharing those keys are comparable regardless of which experiment or machine produced them, which enables `placebo compare` and a shared public results pool later. It costs nothing now; retrofitting it would orphan all early data.
