// Valid sample values of every domain type, as plain input objects. Tests start from these and
// change one field, so each test shows exactly what it is about.

import type { z } from 'zod';
import { Experiment } from '../domain/experiment.js';
import { Review } from '../domain/review.js';
import { Run } from '../domain/run.js';

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:05:00.000Z';
const SHA_A = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

export const sampleRunKey = {
  taskHash: SHA_A,
  variantHash: 'c'.repeat(64),
  commitHash: COMMIT,
  subjectModel: 'claude-sonnet-5',
  claudeCodeVersion: '2.1.283',
};

export const sampleEvents = [
  {
    type: 'system_init',
    timestamp: T0,
    model: 'claude-sonnet-5',
    claudeCodeVersion: '2.1.283',
    tools: ['Read', 'Edit'],
  },
  { type: 'assistant_text', timestamp: T0, text: 'Looking at src/money.ts' },
  {
    type: 'tool_call',
    timestamp: T0,
    id: 'tc1',
    name: 'Read',
    input: { file_path: 'src/money.ts' },
  },
  {
    type: 'tool_result',
    timestamp: T0,
    id: 'tc1',
    output: 'export function refund',
    isError: false,
  },
  { type: 'usage', timestamp: T0, input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 },
  {
    type: 'result',
    timestamp: T1,
    outcome: 'completed',
    costUsd: 0.12,
    turns: 3,
    durationMs: 300_000,
    apiDurationMs: 20_000,
    stopReason: 'end_turn',
    permissionDenials: [],
  },
];

export const sampleMeasurements = {
  tokens: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 },
  costUsd: 0.12,
  turns: 3,
  durationMs: 300_000,
  apiDurationMs: 20_000,
  toolCalls: { total: 1, byTool: { Read: 1 } },
  filesRead: 1,
  bytesRead: 2048,
  searchCalls: 0,
  changeBytes: 120,
  filesTouched: 1,
};

export const sampleChange = {
  diff: '--- a/src/money.ts\n+++ b/src/money.ts\n',
  files: ['src/money.ts'],
  bytes: 39,
};

export const sampleJudgeSpend = {
  costUsd: 0.03,
  tokens: { input: 2000, output: 150, cacheRead: 0, cacheWrite: 0 },
  calls: 1,
};

export const sampleGrades = [
  {
    grader: { type: 'command', index: 0 },
    kind: 'deterministic',
    score: 1,
    passed: true,
    detail: {
      type: 'command',
      command: 'pnpm vitest run',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 900,
    },
  },
  {
    grader: { type: 'checklist', index: 2 },
    kind: 'judge',
    score: 2,
    detail: {
      type: 'judge',
      model: 'claude-opus-5-5',
      reasoning: 'Both hold.',
      raw: [{ answers: [true, true] }],
      answers: [
        { question: 'Rounds half up?', yes: true },
        { question: 'Keeps signature?', yes: true },
      ],
      spend: sampleJudgeSpend,
    },
  },
];

export const sampleRun = {
  id: 'run-1',
  experimentId: 'exp-1',
  key: sampleRunKey,
  taskId: 'refund-rounding',
  arm: { kind: 'treatment', variant: 'none', patch: 'variants/none.patch' },
  startedAt: T0,
  finishedAt: T1,
  outcome: 'completed',
  measurements: sampleMeasurements,
  events: sampleEvents,
  change: sampleChange,
  grades: sampleGrades,
  runFolder: '/tmp/placebo/run-1',
  infraRetries: 0,
};

export const sampleExperiment = {
  id: 'exp-1',
  createdAt: T0,
  pins: {
    commit: COMMIT,
    subjectModel: 'claude-sonnet-5',
    judgeModel: 'claude-opus-5-5',
    claudeCodeVersion: '2.1.283',
    suiteHash: SHA_A,
    placeboVersion: '0.0.0',
  },
  runsPerTask: 5,
  taskIds: ['refund-rounding'],
  arms: [{ kind: 'control' }, { kind: 'treatment', variant: 'none', patch: 'variants/none.patch' }],
  seed: 42,
};

export const sampleReview = {
  id: 'rev-1',
  runId: 'run-1',
  reviewer: 'julien',
  createdAt: T1,
  answer: { type: 'checklist', answers: [{ question: 'Rounds half up?', yes: true }] },
};

export const sampleRow = {
  metric: 'passRate',
  difference: -7,
  range: [-30, 15],
  verdict: 'no_evidence',
  margin: 5,
  runsNeeded: 12,
  taskCount: 3,
  runCount: 30,
};

export const sampleResults = {
  schemaVersion: 1,
  generatedAt: T1,
  experiment: sampleExperiment,
  arms: sampleExperiment.arms,
  margins: { passRate: 5, cost: 10, tokens: 10, duration: 15 },
  tasks: [
    {
      id: 'refund-rounding',
      prompt: 'Fix the rounding.',
      graders: [{ index: 0, type: 'command', label: 'command: pnpm vitest run' }],
    },
  ],
  runs: [sampleRun],
  verdictCards: [{ variant: 'none', rows: [sampleRow] }],
  breakdown: [
    {
      taskId: 'refund-rounding',
      arm: 'control',
      runCount: 5,
      means: { passRate: 0.6, checklist: null },
    },
  ],
  deadTasks: [],
  warnings: [{ type: 'few_tasks', taskCount: 1, threshold: 5 }],
  reviews: [sampleReview],
};

/** Top-level overrides for a builder; an override of `undefined` removes the field. */
type Overrides<Schema extends z.ZodType> = {
  [K in keyof z.input<Schema>]?: z.input<Schema>[K] | undefined;
};

function build<Schema extends z.ZodType>(
  schema: Schema,
  sample: object,
  overrides: object,
): z.output<Schema> {
  const merged: Record<string, unknown> = { ...sample, ...overrides };
  for (const [name, value] of Object.entries(merged))
    if (value === undefined) Reflect.deleteProperty(merged, name);
  return schema.parse(merged);
}

/**
 * Overrides for `makeRun`: any top-level `Run` field, plus two shorthands. `arm` may be an arm
 * name (`control` or a variant name); `measurements` is merged into `sampleMeasurements`, tokens
 * included, so a test names only the fields it is about.
 */
export type MakeRunOverrides = Omit<Overrides<typeof Run>, 'arm' | 'measurements' | 'grades'> & {
  readonly arm?: z.input<typeof Run>['arm'] | string;
  readonly measurements?: Partial<Omit<typeof sampleMeasurements, 'tokens'>> & {
    readonly tokens?: Partial<typeof sampleMeasurements.tokens>;
  };
  /** Grade inputs; validated by the `Run` schema. */
  readonly grades?: readonly unknown[];
};

function armInput(arm: z.input<typeof Run>['arm'] | string): z.input<typeof Run>['arm'] {
  if (typeof arm !== 'string') return arm;
  return arm === 'control'
    ? { kind: 'control' }
    : { kind: 'treatment', variant: arm, patch: `variants/${arm}.patch` };
}

/** A parsed `Run` from `sampleRun` with top-level fields replaced by `overrides`. */
export function makeRun(overrides: MakeRunOverrides = {}): Run {
  const { arm, measurements, ...rest } = overrides;
  return build(Run, sampleRun, {
    ...rest,
    ...('arm' in overrides && { arm: arm === undefined ? undefined : armInput(arm) }),
    ...('measurements' in overrides && {
      measurements:
        measurements === undefined
          ? undefined
          : {
              ...sampleMeasurements,
              ...measurements,
              tokens: { ...sampleMeasurements.tokens, ...measurements.tokens },
            },
    }),
  });
}

/** A parsed `Experiment` from `sampleExperiment` with top-level fields replaced by `overrides`. */
export function makeExperiment(overrides: Overrides<typeof Experiment> = {}): Experiment {
  return build(Experiment, sampleExperiment, overrides);
}

/** A parsed `Review` from `sampleReview` with top-level fields replaced by `overrides`. */
export function makeReview(overrides: Overrides<typeof Review> = {}): Review {
  return build(Review, sampleReview, overrides);
}

/** A deterministic `command` grade. */
export function commandGrade(passed: boolean): unknown {
  return { ...sampleGrades[0], score: passed ? 1 : 0, passed };
}

/** A checklist judge grade scoring `score` yes answers. */
export function checklistGrade(score: number): unknown {
  return { ...sampleGrades[1], score };
}

/** A comparison judge grade: score 1 when this run won, 0 when it lost. */
export function comparisonGrade(won: boolean): unknown {
  return {
    grader: { type: 'comparison', index: 3 },
    kind: 'judge',
    score: won ? 1 : 0,
    detail: {
      type: 'comparison',
      opponentRunId: 'run-0',
      position: 'a',
      preferred: won,
      reason: won ? 'This one is better.' : 'The other one is better.',
      model: 'claude-opus-5-5',
      raw: [{ better: won ? 'a' : 'b', reason: 'Clearer.' }],
      spend: sampleJudgeSpend,
    },
  };
}
