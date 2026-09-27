import { describe, expect, it } from 'vitest';
import { Experiment } from '../domain/experiment.js';
import { Results } from '../domain/results.js';
import type { Run } from '../domain/run.js';
import { Margins } from '../domain/suite.js';
import { FEW_TASKS_THRESHOLD } from '../domain/warnings.js';
import { TaskId, VariantName } from '../kernel/ids.js';
import { createSeededRandom } from '../kernel/random.js';
import {
  checklistGrade,
  commandGrade,
  comparisonGrade,
  makeRun,
  sampleExperiment,
  sampleResults,
} from '../testing/fixtures.js';
import { buildVerdictCard, experimentWarnings, summarizeExperiment } from './verdict-card.js';

const margins = Margins.parse({});

function experiment(taskIds: string[], overrides: object = {}): Experiment {
  return Experiment.parse({ ...sampleExperiment, taskIds, ...overrides });
}

/** `passes` then failures, as runs of one task and arm with a command grade each. */
function passRuns(taskId: string, arm: string, outcomes: boolean[]): Run[] {
  return outcomes.map((passed) => makeRun({ taskId, arm, grades: [commandGrade(passed)] }));
}

function card(runs: Run[], exp: Experiment, seed = 1) {
  return buildVerdictCard({
    runs,
    experiment: exp,
    treatment: VariantName.parse('none'),
    margins,
    random: createSeededRandom(seed),
    resamples: 200,
  });
}

describe('buildVerdictCard', () => {
  it('produces a row per metric with values, in METRICS order', () => {
    const exp = experiment(['a']);
    const runs = [...passRuns('a', 'control', [true, false]), ...passRuns('a', 'none', [true])];
    const { rows } = card(runs, exp);
    expect(rows.map((row) => row.metric)).toEqual([
      'passRate',
      'costUsd',
      'tokensIn',
      'tokensOut',
      'cacheRead',
      'cacheWrite',
      'turns',
      'durationMs',
    ]);
  });

  it('adds checklist and win rate rows when those grades exist', () => {
    const exp = experiment(['a']);
    const runs = [
      makeRun({ taskId: 'a', grades: [checklistGrade(1)] }),
      makeRun({ taskId: 'a', arm: 'none', grades: [checklistGrade(2), comparisonGrade(true)] }),
    ];
    const { rows } = card(runs, exp);
    expect(rows.find((row) => row.metric === 'checklist')).toMatchObject({ difference: 1 });
    expect(rows.find((row) => row.metric === 'winRate')).toMatchObject({
      difference: 50,
      runCount: 1,
    });
    expect(rows.some((row) => row.metric === 'passRate')).toBe(false);
  });

  it('excludes dead tasks from every row and warns about them', () => {
    const exp = experiment(['dead', 'a']);
    const runs = [
      ...passRuns('dead', 'control', [false, false]),
      ...passRuns('dead', 'none', [false, false]),
      ...passRuns('a', 'control', [true, false]),
      ...passRuns('a', 'none', [true, true]),
    ];
    const result = card(runs, exp);
    expect(result.deadTasks).toEqual(['dead']);
    expect(result.warnings).toContainEqual({ type: 'dead_task', taskId: 'dead' });
    for (const row of result.rows) expect(row.taskCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ metric: 'passRate', difference: 50 });
  });

  it('does not call a task dead when another arm passes it, or when it has no pass rate', () => {
    const exp = Experiment.parse({
      ...sampleExperiment,
      taskIds: ['a', 'b'],
      arms: [
        ...sampleExperiment.arms,
        { kind: 'treatment', variant: 'other', patch: 'variants/other.patch' },
      ],
    });
    const runs = [
      ...passRuns('a', 'control', [false]),
      ...passRuns('a', 'none', [false]),
      ...passRuns('a', 'other', [true]),
      makeRun({ taskId: 'b' }),
      makeRun({ taskId: 'b', arm: 'none' }),
    ];
    expect(card(runs, exp).deadTasks).toEqual([]);
  });

  it('counts an ungraded crashed run as a failure when its task has deterministic graders', () => {
    const exp = experiment(['a']);
    const runs = [
      ...passRuns('a', 'control', [true, true]),
      ...passRuns('a', 'none', [true]),
      makeRun({ taskId: 'a', arm: 'none', outcome: 'crashed' }),
    ];
    const passRate = card(runs, exp).rows[0];
    expect(passRate).toMatchObject({ metric: 'passRate', difference: -50, runCount: 4 });
  });

  it('ignores runs of other tasks and arms', () => {
    const exp = experiment(['a']);
    const base = [...passRuns('a', 'control', [true]), ...passRuns('a', 'none', [true])];
    const extra = [
      ...passRuns('elsewhere', 'none', [false]),
      ...passRuns('a', 'stranger', [false]),
    ];
    expect(card([...base, ...extra], exp)).toEqual(card(base, exp));
  });

  it('summarizes control and the treatment per task', () => {
    const exp = experiment(['a']);
    const runs = [
      ...passRuns('a', 'control', [true, false]),
      makeRun({ taskId: 'a', arm: 'none', measurements: { costUsd: 0.3 } }),
    ];
    const { perTask } = card(runs, exp);
    expect(perTask).toHaveLength(2);
    expect(perTask[0]).toMatchObject({ taskId: 'a', arm: 'control', runCount: 2 });
    expect(perTask[0]?.means).toMatchObject({ passRate: 0.5, costUsd: 0.12, winRate: null });
    expect(perTask[1]).toMatchObject({ taskId: 'a', arm: 'none', runCount: 1 });
    expect(perTask[1]?.means).toMatchObject({ passRate: 0, costUsd: 0.3 });
  });

  it('replays exactly from the same seed', () => {
    const exp = experiment(['a', 'b']);
    const runs = [
      ...passRuns('a', 'control', [true, false, true]),
      ...passRuns('a', 'none', [true, true, false]),
      ...passRuns('b', 'control', [false, false, true]),
      ...passRuns('b', 'none', [true, false, true]),
    ];
    expect(card(runs, exp, 9)).toEqual(card(runs, exp, 9));
  });

  it('refuses to compare control with itself', () => {
    expect(() =>
      buildVerdictCard({
        runs: [],
        experiment: experiment(['a']),
        treatment: 'control',
        margins,
        random: createSeededRandom(1),
      }),
    ).toThrow(RangeError);
  });
});

describe('experimentWarnings', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `t${String(i)}`);

  it('warns about few tasks below the threshold, not at it', () => {
    expect(experimentWarnings(experiment(ids(FEW_TASKS_THRESHOLD)), [])).toEqual([]);
    expect(experimentWarnings(experiment(ids(FEW_TASKS_THRESHOLD - 1)), [])).toEqual([
      { type: 'few_tasks', taskCount: FEW_TASKS_THRESHOLD - 1, threshold: FEW_TASKS_THRESHOLD },
    ]);
  });

  it('counts tasks after leaving out dead tasks', () => {
    const warnings = experimentWarnings(experiment(ids(FEW_TASKS_THRESHOLD)), [TaskId.parse('t0')]);
    expect(warnings).toEqual([
      { type: 'dead_task', taskId: 't0' },
      { type: 'few_tasks', taskCount: FEW_TASKS_THRESHOLD - 1, threshold: FEW_TASKS_THRESHOLD },
    ]);
  });

  it('warns when the judge model is the subject model', () => {
    const exp = experiment(ids(FEW_TASKS_THRESHOLD), {
      pins: { ...sampleExperiment.pins, judgeModel: sampleExperiment.pins.subjectModel },
    });
    expect(experimentWarnings(exp, [])).toEqual([
      { type: 'judge_equals_subject', model: sampleExperiment.pins.subjectModel },
    ]);
  });
});

describe('summarizeExperiment', () => {
  it('builds one card per treatment and everything else Results needs', () => {
    const exp = Experiment.parse({
      ...sampleExperiment,
      taskIds: ['a', 'dead'],
      arms: [
        ...sampleExperiment.arms,
        { kind: 'treatment', variant: 'other', patch: 'variants/other.patch' },
      ],
    });
    const runs = [
      ...passRuns('a', 'control', [true, false]),
      ...passRuns('a', 'none', [true, true]),
      ...passRuns('a', 'other', [false, false]),
      ...passRuns('dead', 'control', [false]),
      ...passRuns('dead', 'none', [false]),
      ...passRuns('dead', 'other', [false]),
    ];
    const summary = summarizeExperiment({
      runs,
      experiment: exp,
      margins,
      random: createSeededRandom(exp.seed),
      resamples: 100,
    });
    expect(summary.verdictCards.map((c) => c.variant)).toEqual(['none', 'other']);
    expect(summary.verdictCards[0]?.rows[0]).toMatchObject({ metric: 'passRate', difference: 50 });
    expect(summary.verdictCards[1]?.rows[0]).toMatchObject({ metric: 'passRate', difference: -50 });
    expect(summary.breakdown).toHaveLength(6);
    expect(summary.deadTasks).toEqual(['dead']);
    expect(summary.warnings).toEqual([
      { type: 'dead_task', taskId: 'dead' },
      { type: 'few_tasks', taskCount: 1, threshold: FEW_TASKS_THRESHOLD },
    ]);
    const results = Results.parse({
      ...sampleResults,
      experiment: exp,
      arms: exp.arms,
      runs,
      ...summary,
    });
    expect(results.verdictCards).toHaveLength(2);
  });
});
