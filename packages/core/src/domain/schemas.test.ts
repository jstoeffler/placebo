import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  sampleChange,
  sampleEvents,
  sampleExperiment,
  sampleGrades,
  sampleJudgeSpend,
  sampleMeasurements,
  sampleResults,
  sampleReview,
  sampleRow,
  sampleRun,
  sampleRunKey,
} from '../testing/fixtures.js';
import { Arm, armName, ArmName, CONTROL } from './arm.js';
import { Change } from './change.js';
import { Outcome, RunnerEvent } from './events.js';
import { Experiment } from './experiment.js';
import { Grade, GraderRef } from './grade.js';
import { Measurements } from './measurements.js';
import { METRICS, Metric, MetricRow, Verdict } from './metrics.js';
import { RESULTS_SCHEMA_VERSION, Results } from './results.js';
import { Review } from './review.js';
import { RunKey } from './run-key.js';
import { Run } from './run.js';
import { GraderSpec, Limits, Margins, Suite, Task } from './suite.js';
import { Warning } from './warnings.js';

/** The path and message of every issue, for exact assertions. */
function issuesOf(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected a validation error');
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

function withPath(value: object, path: (string | number)[], replacement: unknown): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let cursor: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  if (replacement === undefined) Reflect.deleteProperty(cursor, last);
  else cursor[last] = replacement;
  return copy;
}

describe('GraderSpec', () => {
  it.each([
    [
      { type: 'command', run: 'pnpm test' },
      { type: 'command', run: 'pnpm test' },
    ],
    [
      { type: 'file_exists', path: 'a' },
      { type: 'file_exists', path: 'a' },
    ],
    [
      { type: 'file_modified', path: 'a' },
      { type: 'file_modified', path: 'a' },
    ],
    [
      { type: 'regex', pattern: 'x+' },
      { type: 'regex', pattern: 'x+', on: 'change' },
    ],
    [
      { type: 'regex', pattern: 'x', on: 'transcript' },
      { type: 'regex', pattern: 'x', on: 'transcript' },
    ],
    [
      { type: 'tool_used', tool: 'Bash' },
      { type: 'tool_used', tool: 'Bash' },
    ],
    [
      { type: 'checklist', questions: 'q.md' },
      { type: 'checklist', questions: 'q.md', agentic: false, repeats: 1 },
    ],
    [
      { type: 'comparison', agentic: true, repeats: 3 },
      { type: 'comparison', agentic: true, repeats: 3 },
    ],
  ])('parses %o with defaults', (input, output) => {
    expect(GraderSpec.parse(input)).toEqual(output);
  });

  it('rejects a bad regex target, zero repeats and an empty command', () => {
    expect(issuesOf(GraderSpec, { type: 'regex', pattern: 'x', on: 'stdout' })).toEqual([
      'on: Invalid option: expected one of "change"|"transcript"',
    ]);
    expect(issuesOf(GraderSpec, { type: 'comparison', repeats: 0 })).toEqual([
      'repeats: Too small: expected number to be >0',
    ]);
    expect(issuesOf(GraderSpec, { type: 'command', run: '' })).toEqual([
      'run: Too small: expected string to have >=1 characters',
    ]);
  });
});

describe('Task', () => {
  const task = { id: 't', prompt: 'p', graders: [{ type: 'tool_used', tool: 'Bash' }] };

  it('accepts a minimal task', () => {
    expect(Task.parse(task)).toEqual(task);
  });

  it('rejects a blank prompt, no graders and unknown keys', () => {
    expect(issuesOf(Task, { ...task, prompt: '  \n' })).toEqual([
      'prompt: prompt must not be empty',
    ]);
    expect(issuesOf(Task, { ...task, graders: [] })).toEqual([
      'graders: a task needs at least one grader',
    ]);
    expect(issuesOf(Task, { ...task, name: 'x' })).toEqual([': Unrecognized key: "name"']);
  });
});

describe('Limits and Margins', () => {
  it('has no limits by default', () => {
    expect(Limits.parse({})).toEqual({});
  });

  it('fills margin defaults from brief §10', () => {
    expect(Margins.parse({})).toEqual({ passRate: 5, cost: 10, tokens: 10, duration: 15 });
    expect(Margins.parse({ cost: 20 })).toMatchObject({ cost: 20, tokens: 10 });
  });

  it('rejects non-positive values', () => {
    expect(issuesOf(Limits, { maxTurns: 0 })).toEqual([
      'maxTurns: Too small: expected number to be >0',
    ]);
    expect(issuesOf(Margins, { passRate: -1 })).toEqual([
      'passRate: Too small: expected number to be >0',
    ]);
  });
});

describe('Suite', () => {
  const suite = {
    commit: 'abcdef1',
    model: 'm',
    judgeModel: 'j',
    variants: { none: { patch: 'variants/none.patch' } },
    tasks: [{ id: 't', prompt: 'p', graders: [{ type: 'tool_used', tool: 'Bash' }] }],
  };

  it('applies defaults', () => {
    expect(Suite.parse(suite)).toMatchObject({ repo: '.', runs: 5, parallelism: 4, sandbox: true });
  });

  it('requires at least one variant and one task, and a hex commit', () => {
    expect(issuesOf(Suite, { ...suite, variants: {} })).toEqual([
      'variants: at least one variant is required',
    ]);
    expect(issuesOf(Suite, { ...suite, tasks: [] })).toEqual([
      'tasks: at least one task is required',
    ]);
    expect(issuesOf(Suite, { ...suite, commit: 'HEAD' })).toEqual([
      'commit: commit must be 7 to 64 lowercase hex characters',
    ]);
    expect(issuesOf(Suite, { ...suite, runs: 1.5 })).toEqual([
      'runs: Invalid input: expected int, received number',
    ]);
  });

  it('requires variant names that start with a letter and are not "control"', () => {
    const patch = { patch: 'variants/x.patch' };
    expect(issuesOf(Suite, { ...suite, variants: { '2x': patch } })).toEqual([
      'variants.2x: variant name must start with a lowercase letter, so it never reads as a number or a run count, followed by lowercase letters, digits, "-" or "_"',
    ]);
    expect(issuesOf(Suite, { ...suite, variants: { control: patch } })).toEqual([
      'variants.control: variant name "control" is reserved',
    ]);
    expect(Suite.parse({ ...suite, variants: { v2: patch } }).variants).toHaveProperty('v2');
  });
});

describe('Arm', () => {
  it('parses control and treatment and names them', () => {
    expect(armName(Arm.parse(CONTROL))).toBe('control');
    expect(armName(Arm.parse({ kind: 'treatment', variant: 'none', patch: 'p' }))).toBe('none');
    expect(ArmName.parse('control')).toBe('control');
  });

  it('rejects a treatment without a patch', () => {
    expect(issuesOf(Arm, { kind: 'treatment', variant: 'none' })).toEqual([
      'patch: Invalid input: expected string, received undefined',
    ]);
  });
});

describe('RunnerEvent', () => {
  it('accepts every event shape', () => {
    for (const event of sampleEvents) expect(RunnerEvent.parse(event)).toEqual(event);
  });

  it('accepts structured output on the result event', () => {
    const result = { ...sampleEvents.at(-1)!, structuredOutput: { winner: 'a' } };
    expect(RunnerEvent.parse(result)).toEqual(result);
  });

  it('requires a timestamp and rejects negative usage', () => {
    expect(issuesOf(RunnerEvent, withPath(sampleEvents[1]!, ['timestamp'], undefined))).toEqual([
      'timestamp: Invalid input: expected string, received undefined',
    ]);
    expect(issuesOf(RunnerEvent, withPath(sampleEvents[4]!, ['cacheRead'], -1))).toEqual([
      'cacheRead: Too small: expected number to be >=0',
    ]);
  });

  it('lists the four outcomes', () => {
    expect(Outcome.options).toEqual([
      'completed',
      'failed',
      'crashed',
      'stopped_by_permission_denial',
    ]);
  });
});

describe('Measurements, Change', () => {
  it('accept valid values', () => {
    expect(Measurements.parse(sampleMeasurements)).toEqual(sampleMeasurements);
    expect(Change.parse(sampleChange)).toEqual(sampleChange);
  });

  it('reject fractional counts with the exact path', () => {
    expect(
      issuesOf(Measurements, withPath(sampleMeasurements, ['toolCalls', 'byTool', 'Read'], 0.5)),
    ).toEqual(['toolCalls.byTool.Read: Invalid input: expected int, received number']);
    expect(issuesOf(Change, { ...sampleChange, bytes: -1 })).toEqual([
      'bytes: Too small: expected number to be >=0',
    ]);
  });
});

describe('Grade', () => {
  it('accepts deterministic, judge and review grades', () => {
    for (const grade of sampleGrades) expect(Grade.parse(grade)).toEqual(grade);
    const review = {
      grader: { type: 'review', index: null },
      kind: 'review',
      score: 1,
      detail: { type: 'review', reviewId: 'rev-1', reviewer: 'julien', answers: [] },
    };
    expect(Grade.parse(review)).toEqual(review);
  });

  it('accepts an error detail with or without the spend of a failed judge', () => {
    const failed = {
      grader: { type: 'checklist', index: 0 },
      kind: 'judge',
      score: 0,
      detail: { type: 'error', message: 'judge returned no structured output' },
    };
    expect(Grade.parse(failed)).toEqual(failed);
    const withSpend = { ...failed, detail: { ...failed.detail, spend: sampleJudgeSpend } };
    expect(Grade.parse(withSpend)).toEqual(withSpend);
    expect(
      issuesOf(Grade, { ...failed, detail: { ...failed.detail, spend: { costUsd: -1 } } }),
    ).toEqual([
      'detail.spend.costUsd: Too small: expected number to be >=0',
      'detail.spend.tokens: Invalid input: expected object, received undefined',
      'detail.spend.calls: Invalid input: expected number, received undefined',
    ]);
  });

  it('ties review refs to a null index', () => {
    expect(GraderRef.safeParse({ type: 'review', index: 0 }).success).toBe(false);
    expect(issuesOf(GraderRef, { type: 'command', index: null })).toEqual([
      'index: Invalid input: expected number, received null',
    ]);
  });

  it('keeps comparison fields off the judge detail, which only checklist judges produce', () => {
    const judge = sampleGrades[1]!;
    const withOpponent = { ...judge, detail: { ...judge.detail, opponentRunId: 'run-2' } };
    expect(issuesOf(Grade, withOpponent)).toEqual(['detail: Unrecognized key: "opponentRunId"']);
  });

  it('requires the judge spend, with whole call counts', () => {
    const judge = sampleGrades[1]!;
    const { spend, ...withoutSpend } = judge.detail;
    expect(issuesOf(Grade, { ...judge, detail: withoutSpend })).toEqual([
      'detail.spend: Invalid input: expected object, received undefined',
    ]);
    expect(
      issuesOf(Grade, { ...judge, detail: { ...judge.detail, spend: { ...spend, calls: 1.5 } } }),
    ).toEqual(['detail.spend.calls: Invalid input: expected int, received number']);
  });

  it('rejects an unknown detail type', () => {
    expect(issuesOf(Grade, withPath(sampleGrades[0]!, ['detail', 'type'], 'stdout'))).toEqual([
      "detail.type: Invalid discriminator value. Expected 'command' | 'check' | 'judge' | 'comparison' | 'error' | 'review'",
    ]);
  });
});

describe('Review', () => {
  it('accepts checklist and comparison reviews', () => {
    expect(Review.parse(sampleReview)).toEqual(sampleReview);
    const comparison = {
      ...sampleReview,
      answer: { type: 'comparison', opponentRunId: 'run-2', won: true },
    };
    expect(Review.parse(comparison)).toEqual(comparison);
  });

  it('requires a reviewer name', () => {
    expect(issuesOf(Review, { ...sampleReview, reviewer: '' })).toEqual([
      'reviewer: Too small: expected string to have >=1 characters',
    ]);
  });
});

describe('RunKey, Run, Experiment', () => {
  it('accept valid values', () => {
    expect(RunKey.parse(sampleRunKey)).toEqual(sampleRunKey);
    expect(Run.parse(sampleRun)).toEqual(sampleRun);
    expect(Experiment.parse(sampleExperiment)).toEqual(sampleExperiment);
  });

  it('reject an abbreviated commit, a bad nested event and a lone arm', () => {
    expect(issuesOf(RunKey, { ...sampleRunKey, commitHash: 'abc1234' })).toEqual([
      'commitHash: must be a full lowercase commit id',
    ]);
    expect(issuesOf(Run, withPath(sampleRun, ['events', 2, 'name'], 7))).toEqual([
      'events.2.name: Invalid input: expected string, received number',
    ]);
    expect(issuesOf(Experiment, { ...sampleExperiment, arms: [{ kind: 'control' }] })).toEqual([
      'arms: Too small: expected array to have >=2 items',
    ]);
    expect(issuesOf(Experiment, { ...sampleExperiment, seed: -1 })).toEqual([
      'seed: Too small: expected number to be >=0',
    ]);
  });
});

describe('metrics and verdicts', () => {
  it('describes every metric', () => {
    expect(Object.keys(METRICS)).toEqual(Metric.options);
    expect(METRICS.passRate).toEqual({
      label: 'pass rate',
      higherIsBetter: true,
      unit: 'pts',
      margin: 'passRate',
    });
    expect(METRICS.costUsd.higherIsBetter).toBe(false);
  });

  it('has exactly four verdicts', () => {
    expect(Verdict.options).toEqual(['helps', 'harms', 'placebo', 'no_evidence']);
  });

  it('validates metric rows', () => {
    expect(MetricRow.parse(sampleRow)).toEqual(sampleRow);
    expect(issuesOf(MetricRow, { ...sampleRow, range: [2, 1] })).toEqual([
      'range: range must be [low, high]',
    ]);
    expect(issuesOf(MetricRow, { ...sampleRow, verdict: 'helps' })).toEqual([
      'runsNeeded: runsNeeded is only set on no_evidence rows',
    ]);
    expect(
      MetricRow.parse({ ...sampleRow, verdict: 'helps', runsNeeded: undefined, margin: null }),
    ).toMatchObject({
      verdict: 'helps',
    });
  });
});

describe('Warning', () => {
  it.each([
    { type: 'few_tasks', taskCount: 3, threshold: 5 },
    { type: 'judge_equals_subject', model: 'claude-sonnet-5' },
    { type: 'patch_outside_surface', variant: 'arch', paths: ['docs/arch.md'] },
    { type: 'dead_task', taskId: 't' },
    { type: 'isolation_residual', sources: ['global_config'] },
  ])('accepts %o', (warning) => {
    expect(Warning.parse(warning)).toEqual(warning);
  });

  it('requires at least one path outside the surface', () => {
    expect(
      issuesOf(Warning, { type: 'patch_outside_surface', variant: 'arch', paths: [] }),
    ).toEqual(['paths: Too small: expected array to have >=1 items']);
  });
});

describe('Results', () => {
  it('round-trips through JSON', () => {
    const parsed = Results.parse(JSON.parse(JSON.stringify(sampleResults)));
    expect(parsed).toEqual(sampleResults);
    expect(parsed.schemaVersion).toBe(RESULTS_SCHEMA_VERSION);
  });

  it('rejects an unknown schema version and a bad nested run', () => {
    expect(issuesOf(Results, { ...sampleResults, schemaVersion: 2 })).toEqual([
      'schemaVersion: Invalid input: expected 1',
    ]);
    expect(issuesOf(Results, withPath(sampleResults, ['runs', 0, 'outcome'], 'timeout'))).toEqual([
      'runs.0.outcome: Invalid option: expected one of "completed"|"failed"|"crashed"|"stopped_by_permission_denial"',
    ]);
  });
});
