---
status: accepted
---
# Variants are patch files against the pinned commit

A treatment is a patch applied on the snapshot, not an overlay directory and not a git ref. One representation can add, edit and delete anything, lives in the repo as a reviewable file, and the "no configuration at all" arm needs no special case: it is a patch that deletes the config files. A patch touching files outside the configuration surface warns and proceeds.

## Consequences

Overlay directories or git refs, if ever wanted for authoring, are converted to a patch. The measured change of a run is always computed against snapshot plus patch, so a variant's own files never leak into what the judge sees.
