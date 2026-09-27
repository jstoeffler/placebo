---
status: accepted
---
# The run store index uses `node:sqlite`

Runs are stored as one JSON file each, with a SQLite index for listing and lookup by run key. The index uses `node:sqlite`, built into Node 26, so Placebo has zero native dependencies: no compile step on install, no prebuilt binaries per platform, nothing that breaks `npx` on an unusual machine. The JSON files stay the source of truth; the index can be rebuilt from them.

## Consequences

Node 26 is the minimum. Core never imports `node:sqlite`; the store lives in the cli's adapters behind the `RunStore` port.
