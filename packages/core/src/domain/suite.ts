import { z } from 'zod';
import { TaskId, VariantName } from '../kernel/ids.js';

/** A path relative to `.placebo/`, such as `variants/none.patch`. */
const SuitePath = z.string().min(1, { error: 'path must not be empty' });

/** At most one judge call per grader unless the suite asks for more. */
const Repeats = z.int().positive();

/**
 * A grader as declared in `suite.yaml`. Type names match `claude plugin eval` where the two
 * overlap (`file_exists`, `regex`, `tool_used`).
 */
export const GraderSpec = z.discriminatedUnion(
  'type',
  [
    /**
     * Runs `run` in the run folder after hidden files are injected; passes on exit code 0.
     * Each `hidden` entry is the destination path in the run folder; its content is read from
     * `.placebo/tasks/<task id>/<path>`.
     */
    z.strictObject({
      type: z.literal('command'),
      run: z.string().min(1),
      hidden: z.array(z.string().min(1)).optional(),
    }),
    /** Passes if `path` exists in the run folder after the run. */
    z.strictObject({ type: z.literal('file_exists'), path: z.string().min(1) }),
    /** Passes if `path` is part of the change. */
    z.strictObject({ type: z.literal('file_modified'), path: z.string().min(1) }),
    /** Passes if `pattern` matches the change (default) or the transcript. */
    z.strictObject({
      type: z.literal('regex'),
      pattern: z
        .string()
        .refine(isValidRegex, { error: 'pattern is not a valid regular expression' }),
      on: z.enum(['change', 'transcript']).default('change'),
    }),
    /** Passes if the agent called `tool` at least once. */
    z.strictObject({ type: z.literal('tool_used'), tool: z.string().min(1) }),
    /** Judge answers each yes/no question in the `questions` file; score is the count of yes. */
    z.strictObject({
      type: z.literal('checklist'),
      questions: SuitePath,
      agentic: z.boolean().default(false),
      repeats: Repeats.default(1),
    }),
    /** Judge compares this run with a run of the other arm, blinded; produces a win rate. */
    z.strictObject({
      type: z.literal('comparison'),
      agentic: z.boolean().default(false),
      repeats: Repeats.default(1),
    }),
  ],
  {
    error:
      'type must be one of command, file_exists, file_modified, regex, tool_used, checklist, comparison',
  },
);
export type GraderSpec = z.infer<typeof GraderSpec>;
export type GraderType = GraderSpec['type'];
export const GRADER_TYPES = [
  'command',
  'file_exists',
  'file_modified',
  'regex',
  'tool_used',
  'checklist',
  'comparison',
] as const satisfies readonly GraderType[];

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const Task = z.strictObject({
  id: TaskId,
  /** Sent to the agent bare, with no wrapper. */
  prompt: z
    .string()
    .refine((prompt) => prompt.trim() !== '', { error: 'prompt must not be empty' }),
  graders: z.array(GraderSpec).min(1, { error: 'a task needs at least one grader' }),
  /** Questions file (relative to `.placebo/`) shown to reviewers in `placebo review`. */
  review: z.strictObject({ questions: SuitePath }).optional(),
});
export type Task = z.infer<typeof Task>;

export const Variant = z.strictObject({
  /** Variant patch, relative to `.placebo/`. */
  patch: SuitePath,
});
export type Variant = z.infer<typeof Variant>;

/** Opt-in limits (ADR 0008). All absent by default: no turn, cost or time cap. */
export const Limits = z.strictObject({
  maxTurns: z.int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  maxDurationMs: z.int().positive().optional(),
});
export type Limits = z.infer<typeof Limits>;

/**
 * Margins (brief §10). `passRate` is in percentage points; the others are percent of the
 * control value.
 */
export const DEFAULT_MARGINS = { passRate: 5, cost: 10, tokens: 10, duration: 15 } as const;

export const Margins = z.strictObject({
  passRate: z.number().positive().default(DEFAULT_MARGINS.passRate),
  cost: z.number().positive().default(DEFAULT_MARGINS.cost),
  tokens: z.number().positive().default(DEFAULT_MARGINS.tokens),
  duration: z.number().positive().default(DEFAULT_MARGINS.duration),
});
export type Margins = z.infer<typeof Margins>;
export type MarginKey = keyof Margins;

export const SUITE_DEFAULTS = { repo: '.', runs: 5, parallelism: 4, sandbox: true } as const;

/**
 * A parsed suite, camelCase. `suite.yaml` itself is snake_case; use `parseSuite` to read it.
 * Defaults are applied, so every optional-with-default field is present after parsing.
 */
export const Suite = z
  .strictObject({
    repo: z.string().min(1).default(SUITE_DEFAULTS.repo),
    /** Commit as written; the executor resolves it to a full `CommitSha`. */
    commit: z
      .string({ error: 'commit must be a string; quote it in YAML, e.g. commit: "0123456"' })
      .regex(/^[0-9a-f]{7,64}$/, { error: 'commit must be 7 to 64 lowercase hex characters' }),
    /** Subject model, full model ID. */
    model: z.string().min(1),
    /** Judge model, full model ID; should differ from `model` (a warning fires otherwise). */
    judgeModel: z.string().min(1),
    runs: z.int().positive().default(SUITE_DEFAULTS.runs),
    parallelism: z.int().positive().default(SUITE_DEFAULTS.parallelism),
    setup: z.string().min(1).optional(),
    sandbox: z.boolean().default(SUITE_DEFAULTS.sandbox),
    limits: Limits.optional(),
    margins: Margins.prefault({}),
    variants: z
      .record(VariantName, Variant)
      .refine((variants) => Object.keys(variants).length > 0, {
        error: 'at least one variant is required',
      }),
    tasks: z.array(Task).min(1, { error: 'at least one task is required' }),
  })
  .superRefine((suite, ctx) => {
    const seen = new Set<string>();
    suite.tasks.forEach((task, index) => {
      if (seen.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'id'],
          message: `duplicate task id "${task.id}"`,
        });
      }
      seen.add(task.id);
    });
  });
export type Suite = z.infer<typeof Suite>;
export type SuiteInput = z.input<typeof Suite>;
