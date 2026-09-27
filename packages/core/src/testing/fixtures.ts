// Valid sample values of every domain type, as plain input objects. Tests start from these and
// change one field, so each test shows exactly what it is about.

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

let runCounter = 0;

export interface MakeRunInput {
  /** `control` or a variant name. Defaults to `control`. */
  readonly arm?: string;
  readonly taskId?: string;
  readonly outcome?: string;
  /** Shallow overrides of `sampleMeasurements`; `tokens` is merged too. */
  readonly measurements?: Partial<Omit<typeof sampleMeasurements, 'tokens'>> & {
    readonly tokens?: Partial<typeof sampleMeasurements.tokens>;
  };
  /** Defaults to no grades. */
  readonly grades?: readonly unknown[];
}

/** A parsed `Run` built from `sampleRun`, with a fresh id. */
export function makeRun(input: MakeRunInput = {}): Run {
  runCounter += 1;
  const arm = input.arm ?? 'control';
  return Run.parse({
    ...sampleRun,
    id: `run-${String(runCounter)}`,
    taskId: input.taskId ?? sampleRun.taskId,
    arm:
      arm === 'control'
        ? { kind: 'control' }
        : { kind: 'treatment', variant: arm, patch: `variants/${arm}.patch` },
    outcome: input.outcome ?? 'completed',
    measurements: {
      ...sampleMeasurements,
      ...input.measurements,
      tokens: { ...sampleMeasurements.tokens, ...input.measurements?.tokens },
    },
    grades: input.grades ?? [],
  });
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
      type: 'judge',
      model: 'claude-opus-5-5',
      reasoning: won ? 'This one is better.' : 'The other one is better.',
      raw: [{ winner: won ? 'a' : 'b' }],
      opponentRunId: 'run-0',
      shownAs: 'a',
    },
  };
}
