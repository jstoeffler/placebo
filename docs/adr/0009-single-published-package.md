---
status: accepted
---
# One published package, `placebo-eval`, bundling core and the report

The workspace has three packages, `core`, `cli` and `report`, but only `placebo-eval` (the cli) is published. Its build bundles core into one ESM file for Node 26 and ships the report's built single-file HTML as an asset, so `npx placebo-eval` installs one package with two small runtime dependencies. `@anthropic-ai/claude-agent-sdk` stays an external dependency because it pins the bundled Claude Code binary through its own platform packages (brief §7), which must not be inlined.

## Considered options

Publishing core and report separately, rejected because nobody consumes them on their own yet and every extra package is a version to keep in step. Splitting later is cheap; unpublishing is not.
