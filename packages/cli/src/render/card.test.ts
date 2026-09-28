import { TaskId } from '@placebo-eval/core';
import { Results } from '@placebo-eval/core/results';
import { sampleExperiment, sampleResults } from '@placebo-eval/core/testing';
import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { renderCard, renderResults, renderTaskTable, warningSentences } from './card.js';

const plain = pc.createColors(false);

function results(overrides: Record<string, unknown> = {}): Results {
  return Results.parse({
    ...sampleResults,
    experiment: {
      ...sampleExperiment,
      taskIds: ['refund-rounding', 'webhook-signature', 'date-utils'],
    },
    ...overrides,
  });
}

const row = (
  metric: string,
  difference: number,
  range: [number, number],
  verdict: string,
  runsNeeded?: number,
) => ({
  metric,
  difference,
  range,
  verdict,
  margin: null,
  taskCount: 3,
  runCount: 30,
  ...(runsNeeded === undefined ? {} : { runsNeeded }),
});

describe('renderCard', () => {
  it('reproduces the brief §5 card', () => {
    const data = results({
      verdictCards: [
        {
          variant: 'none',
          rows: [
            // Out of order on purpose: the card prints rows in card order.
            row('tokensIn', -21, [-27, -15], 'helps'),
            row('passRate', -7, [-30, 15], 'no_evidence', 12),
            row('costUsd', -18, [-24, -12], 'helps'),
            row('turns', -1.2, [-2.6, 0.3], 'no_evidence', 20),
            row('checklist', -0.4, [-1.1, 0.2], 'no_evidence', 30),
          ],
        },
      ],
    });
    const card = data.verdictCards[0];
    if (card === undefined) throw new Error('no card');
    // The brief's example leaves out the runs-needed note of its last two rows; every
    // `no evidence` row carries one (brief §10).
    expect(renderCard(card, data, plain)).toBe(
      [
        'none vs control            5 runs × 3 tasks    model claude-sonnet-5    claude code 2.1.283',
        '  pass rate     -7 pts    [-30, +15]     no evidence   (≈12 runs/task to decide)',
        '  cost          -18 %     [-24, -12]     helps',
        '  tokens in     -21 %     [-27, -15]     helps',
        '  turns         -1.2      [-2.6, +0.3]   no evidence   (≈20 runs/task to decide)',
        '  checklist     -0.4      [-1.1, +0.2]   no evidence   (≈30 runs/task to decide)',
        '',
      ].join('\n'),
    );
  });

  it('widens columns for long values and says when no metric has data', () => {
    const data = results({
      experiment: { ...sampleExperiment, runsPerTask: 1 },
      verdictCards: [
        {
          variant: 'a-very-long-variant-name',
          rows: [row('cacheWrite', -1234.5, [-99999, -1000], 'helps')],
        },
        { variant: 'none', rows: [] },
      ],
    });
    const [long, empty] = data.verdictCards;
    if (long === undefined || empty === undefined) throw new Error('no card');
    expect(renderCard(long, data, plain)).toBe(
      [
        'a-very-long-variant-name vs control    1 run × 1 task    model claude-sonnet-5    claude code 2.1.283',
        '  cache write   -1235 %   [-99999, -1000]   helps',
        '',
      ].join('\n'),
    );
    expect(renderCard(empty, data, plain)).toContain('no metric has data for this treatment');
  });

  it('colours the verdict word only', () => {
    const colors = pc.createColors(true);
    const data = results({
      verdictCards: [
        {
          variant: 'none',
          rows: [
            row('passRate', 10, [6, 14], 'helps'),
            row('costUsd', 20, [12, 30], 'harms'),
            row('tokensIn', 1, [-2, 3], 'placebo'),
            row('turns', 1, [-2, 3], 'no_evidence', 9),
          ],
        },
      ],
    });
    const card = data.verdictCards[0];
    if (card === undefined) throw new Error('no card');
    const text = renderCard(card, data, colors);
    expect(text).toContain(colors.green('helps'));
    expect(text).toContain(colors.red('harms'));
    expect(text).toContain(colors.cyan('placebo'));
    expect(text).toContain(colors.dim('no evidence   (≈9 runs/task to decide)'));
  });
});

describe('renderTaskTable', () => {
  it('prints runs and per-run means for each task and arm', () => {
    const data = results({
      experiment: { ...sampleExperiment, taskIds: ['refund-rounding', 'dead-one'] },
      deadTasks: ['dead-one'],
      breakdown: [
        {
          taskId: 'refund-rounding',
          arm: 'control',
          runCount: 5,
          means: { passRate: 0.6, costUsd: 0.1234, turns: 4.25, durationMs: 12_340 },
        },
        {
          taskId: 'refund-rounding',
          arm: 'none',
          runCount: 5,
          means: { passRate: 0.8, costUsd: 0.1, turns: null, durationMs: 61_000 },
        },
        { taskId: 'dead-one', arm: 'control', runCount: 5, means: { passRate: 0 } },
      ],
    });
    expect(renderTaskTable(data, plain)).toBe(
      [
        'task             arm      runs  pass rate   cost  turns  duration',
        'refund-rounding  control     5       60 %  $0.12    4.3    12.3 s',
        '                 none        5       80 %  $0.10      -  1 m 01 s',
        'dead-one (dead)  control     5        0 %      -      -         -',
        '',
      ].join('\n'),
    );
  });
});

describe('warnings', () => {
  it('says each warning once and adds dead tasks the warnings do not name', () => {
    expect(
      warningSentences({
        warnings: [
          { type: 'dead_task', taskId: TaskId.parse('a') },
          { type: 'few_tasks', taskCount: 2, threshold: 5 },
        ],
        deadTasks: [TaskId.parse('a'), TaskId.parse('b')],
      }),
    ).toEqual([
      'task "a" scored zero in every arm; it is left out of the verdicts',
      'only 2 tasks (fewer than 5): results describe these tasks, not the repo in general',
      'task "b" scored zero in every arm; it is left out of the verdicts',
    ]);
  });

  it('prints cards, the table and warning lines together', () => {
    const text = renderResults(results(), plain);
    expect(text).toMatch(/^none vs control {12}5 runs × 3 tasks/);
    expect(text).toContain('  pass rate     -7 pts');
    expect(text).toContain('task             arm      runs');
    expect(text).toContain(
      'warning: only 1 task (fewer than 5): results describe these tasks, not the repo in general',
    );
  });
});
