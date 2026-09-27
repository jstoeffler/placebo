---
status: accepted
---
# `results.json` is a versioned contract defined once in core

The cli writes `results.json` and embeds the same data in `report.html`; the report reads it. The shape is one Zod schema, `Results`, in `packages/core/src/domain/results.ts`, carrying `schemaVersion`. The report imports it only through the subpath export `@placebo-eval/core/results`, type-only where possible, so the report never pulls the rest of core into its bundle and dependency-cruiser can hold that line.

## Consequences

Additive changes keep the version. Renaming or removing a field, or changing its meaning, bumps `RESULTS_SCHEMA_VERSION`, and the report shows a clear error for versions it does not know. Third parties may read `results.json`; the version is what they check.
