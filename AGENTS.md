# Placebo

Placebo is a TypeScript CLI that measures whether a Claude Code configuration change helps: it runs tasks against a sealed snapshot of a repo under the control arm and each treatment, several runs each, grades every run, and reports per metric a difference, a range and a verdict. The brief in `docs/brief.md` is the source of truth for behaviour; the ADRs in `docs/adr/` record the decisions that are hard to reverse.

Before adding or editing any instruction file, load the `writing-rules` skill.

## Vocabulary

`CONTEXT.md` defines every domain term. Code, types, CLI output, comments and docs use those exact words and never the alternatives it lists under _Avoid_.

## Architecture

Three packages. **core** holds everything framework-free, in layers. **cli** is the composition root: it wires core to the real adapters and renders output. **report** is the React report, built into one self-contained HTML file that cli ships.

Layers of core, from the bottom:

- **kernel**: primitives shared by every layer (success-or-failure values, ids, hashing, randomness, time).
- **domain**: schemas, their inferred types and the pure rules over them.
- **ports**: interfaces only; each interface's doc comment is its contract.
- **statistics**: pure computation of differences, ranges, verdicts and runs needed.
- **graders**: one module per grader type.
- **commands**: one module per CLI command, taking ports and reporting progress through the reporter port.
- **adapters**: port implementations that need only Node built-ins. Implementations needing anything else live in cli.

Core exposes a public API and, separately, the results contract that report depends on. Anything outside core uses only those two entry points.

## Dependency rules

Enforced by dependency-cruiser in `pnpm check`:

- kernel imports only Node built-ins and zod.
- domain imports only kernel, zod and yaml.
- ports and statistics import only domain and kernel.
- graders import only domain, ports and kernel.
- commands import domain, ports, graders, statistics and kernel; never adapters.
- An adapter never imports commands, graders, statistics or another adapter.
- core never imports the Agent SDK, SQLite, React, cli or report.
- cli imports core only through its two entry points and never imports report code.
- report imports only core's results contract from the workspace.
- Production code never imports tests, test fixtures or vitest. No cycles anywhere.

## Checks

`pnpm check` runs lint, typecheck, dependency rules, dead-code detection and tests with coverage, stopping at the first failure. Work is done when `pnpm check` and `pnpm build` pass. A hook lints and typechecks the package of every TypeScript file you edit; fix what it reports before moving on.

## Testing

- Tests spend zero real tokens: commands run against the fake runner and the in-memory store.
- The local executor is tested with real git in temporary directories.
- Tests sit next to the code they test; sample values come from the shared test fixtures.
- Schema tests assert the exact issue path and message, not just failure.
- Coverage on core stays at or above the configured threshold; the run fails below it.
- Randomness comes from a seeded source and time from a fixed clock.

## Conventions

- Expected failures are returned as values; infrastructure failures throw typed errors; anything else that throws is a bug.
- Every external input (suite, stored runs, runner output, results) passes a Zod schema at the edge.
- Commands never write to stdout or stderr; they emit progress events to the reporter.
- No turn, cost or time limit exists by default (ADR 0008); limits are opt-in suite settings only.
- Every number shown to a user carries its range.
- Relative imports use the `.js` extension; type-only imports use `import type`.

## Extending

- **A grader** is a new variant of the suite's grader schema, with its defaults, plus one module in graders. Judges are Claude Code queries through the Runner port with a structured output schema and the least tool access that works (ADR 0007). Parsing of valid, invalid and defaulted specs is tested alongside the grader itself.
- **A metric** is declared once in domain with its direction, unit and margin, computed per run in statistics, and rendered in report. Additive changes keep the results contract version; renames and removals bump it (ADR 0013).
- **A command** is a function in commands taking its ports, a reporter, a clock and a random source; it is tested with the fake runner and the in-memory store, and cli wires it to the real adapters.
- **A port implementation** goes in core's adapters when Node built-ins suffice, otherwise in cli. It is tested against every clause of the port's contract and wired only in the composition root.

## Decisions

Write an ADR when a decision is hard to reverse, surprising to a newcomer, or the result of a real trade-off: next free number, same shape as the existing ones. Link it from code only where the code would otherwise look wrong.

## Commits

Conventional commits, scoped by package when the change sits in one. One logical change per commit. No changesets before 0.1.0; `docs/releasing.md` covers releases.

## The ratchet

Every convention is either mechanically enforced or explicitly labeled as judgment. The dependency rules, the checks and the coverage threshold are enforced. Conventions, Extending and the ADR trigger are judgment. When a judgment rule is broken twice, turn it into a lint rule, a dependency rule or a test, and move it up; prose is the last resort.
