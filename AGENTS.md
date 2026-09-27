# Placebo

Placebo is a TypeScript CLI that measures whether a Claude Code configuration change helps: it runs tasks against a sealed snapshot of a repo under the control arm and each treatment, several runs each, grades every run, and reports per metric a difference, a range and a verdict. `docs/brief.md` is the source of truth for behaviour; `docs/adr/` records the decisions that are hard to reverse.

## Vocabulary

`CONTEXT.md` defines every domain term. Code, types, CLI output, comments and docs use those exact words and never the listed _Avoid_ alternatives. The three most often slipped:

- **control**, never baseline, A or "without".
- **change**, never diff (in prose), output or result. A `Change` has a `diff` field; the concept is the change.
- **range**, never confidence interval, CI or error bars; and **resampling**, never bootstrap.

## Layout

| Where | What goes there |
|---|---|
| `packages/core/src/kernel/` | Shared primitives: `Result`, branded ids, `sha256`/`hashCanonical`, `Random`, `Clock`. |
| `packages/core/src/domain/` | Zod schemas and inferred types, `parseSuite`, run-key hashing, the `Results` contract. |
| `packages/core/src/ports/` | Interfaces only: `Runner`, `Executor`, `RunStore`, `Reporter`. Each doc comment is the contract. |
| `packages/core/src/statistics/` | Resampling, differences, ranges, verdicts, runs needed. Pure. |
| `packages/core/src/graders/` | One module per grader type. |
| `packages/core/src/commands/` | One module per CLI command; takes ports, reports through `Reporter`. |
| `packages/core/src/adapters/<name>/` | Port implementations needing only Node built-ins: local executor, fake runner, memory store. |
| `packages/core/src/testing/` | Fixtures for tests only. |
| `packages/cli/src/` | Composition root: commander wiring, rendering, `src/adapters/` for the SDK runner, CLI runner and `node:sqlite` store. |
| `packages/report/src/` | React report, built to one self-contained `dist/report.html`. |

Public API of core: `packages/core/src/index.ts` (everything) and `packages/core/src/results.ts` (the `results.json` contract). New public modules are added to `index.ts` in alphabetical order within their section.

## Dependency rules

Enforced by `.dependency-cruiser.cjs` (`pnpm depcruise`):

- `kernel` imports only Node built-ins and zod.
- `domain` imports only `kernel`, zod, and yaml (for `parseSuite`).
- `ports` and `statistics` import only `domain` and `kernel`.
- `graders` import only `domain`, `ports` and `kernel`.
- `commands` import `domain`, `ports`, `graders`, `statistics` and `kernel`; never `adapters`.
- `adapters/*` never import `commands`, `graders`, `statistics` or each other.
- core never imports `@anthropic-ai/claude-agent-sdk`, `node:sqlite`, React, cli or report.
- cli imports core only through `@placebo-eval/core` and `@placebo-eval/core/results`, and never imports report code (it ships the built `report.html`).
- report imports only `@placebo-eval/core/results` from the workspace.
- Production code never imports tests, `src/testing/` or vitest. No cycles anywhere.

## Checks

`pnpm check` runs lint (ESLint + Prettier), typecheck (`tsc -b`), depcruise, knip, and tests with coverage, in that order, stopping at the first failure. Work is done when `pnpm check` and `pnpm build` pass. A PostToolUse hook (`scripts/post-edit-check.ts`) lints and typechecks the package of every TypeScript file you edit; fix what it reports before moving on.

## Testing

- Tests spend zero real tokens. Commands are tested against the fake runner and the memory store.
- The local executor is tested with real git in temporary directories.
- Tests sit next to the code as `*.test.ts`; sample values come from `packages/core/src/testing/fixtures.ts`.
- Schema tests assert the exact issue path and message, not just failure.
- Coverage on `packages/core/src/**` stays at or above 90% for lines, branches, functions and statements; the run fails below.
- Randomness in tests comes from `createSeededRandom(seed)`; time comes from a fixed `Clock`.

## Conventions

- Expected failures return `Result`; infrastructure failures throw typed errors such as `RunnerInfraError`; anything else that throws is a bug.
- Every external input (suite.yaml, stored runs, runner output, results.json) passes a Zod schema at the edge.
- Commands write nothing to stdout or stderr; they emit `ProgressEvent`s to a `Reporter`.
- No turn, cost or time limit is added anywhere by default (ADR 0008). Limits exist only as opt-in suite settings.
- Relative imports use the `.js` extension; type-only imports use `import type`.

## Recipes

Add a grader:
1. Add its variant to `GraderSpec` and `GRADER_TYPES` in `packages/core/src/domain/suite.ts`, with defaults, and extend `GradeDetail` in `domain/grade.ts` only if no detail shape fits.
2. Implement it in `packages/core/src/graders/<type>.ts`; judges call the `Runner` port with `tools: 'none'`, `maxTurns: 1` and an `outputSchema` (ADR 0007).
3. Cover valid, invalid and default parsing in `domain/schemas.test.ts`, and the grader against fixtures.

Add a metric:
1. Add it to `Metric` and `METRICS` in `packages/core/src/domain/metrics.ts` with direction, unit and margin key.
2. Compute its per-run value in `packages/core/src/statistics/`.
3. Render it in the report. Additive changes keep `RESULTS_SCHEMA_VERSION`; renames or removals bump it.

Add a command:
1. Write `packages/core/src/commands/<name>.ts` as a function taking ports, a `Reporter`, a `Clock` and a `Random`.
2. Test it with the fake runner and memory store.
3. Replace its stub in `packages/cli/src/program.ts`, wiring the real adapters.

Add a port implementation:
1. Put it in `packages/core/src/adapters/<name>/` if it needs only Node built-ins, otherwise in `packages/cli/src/adapters/`.
2. Test it against every clause of the port's doc comment.
3. Wire it in the cli composition root.

## Decisions

Write an ADR in `docs/adr/NNNN-slug.md` (next free number, same frontmatter and shape as the existing ones) when a decision is hard to reverse, surprising to a newcomer, or the result of a real trade-off. Link it from code only where the code would otherwise look wrong.

## Commits

Conventional commits: `feat(core): …`, `fix(cli): …`, `chore: …`, `ci: …`, `docs: …`, `test(report): …`. One logical change per commit. No changesets before 0.1.0; see `docs/releasing.md`.

## The ratchet

Every convention is either mechanically enforced or explicitly labeled as judgment. The rules in "Dependency rules", "Checks" and the coverage threshold are enforced. "Conventions", "Recipes" and the ADR trigger are judgment. When a judgment rule is broken twice, turn it into a lint rule, a depcruise rule or a test, and move it up; prose is the last resort.
