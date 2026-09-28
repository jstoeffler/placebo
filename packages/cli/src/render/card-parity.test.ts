import { METRICS } from '@placebo-eval/core';
import {
  formatDifference,
  formatExcludedTasks,
  formatRange,
  formatRunsNeededNote,
  formatVerdict,
} from '@placebo-eval/core/format';
import { Results } from '@placebo-eval/core/results';
import { sampleExperiment, sampleResults } from '@placebo-eval/core/testing';
import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { renderCard } from './card.js';

const plain = pc.createColors(false);

/** One results fixture whose rows cover every verdict, unit, note and exclusion. */
const results = Results.parse({
  ...sampleResults,
  experiment: {
    ...sampleExperiment,
    taskIds: ['refund-rounding', 'webhook-signature', 'date-utils'],
  },
  verdictCards: [
    {
      variant: 'none',
      rows: [
        {
          metric: 'passRate',
          difference: -7.4,
          range: [-30.2, 15.1],
          verdict: 'no_evidence',
          margin: 5,
          runsNeeded: 12,
          taskCount: 3,
          runCount: 30,
        },
        {
          metric: 'costUsd',
          difference: -18.3,
          range: [-24.9, -12.2],
          verdict: 'helps',
          margin: 10,
          taskCount: 2,
          runCount: 20,
          excludedTasks: [{ taskId: 'date-utils', reason: 'control_zero' }],
        },
        {
          metric: 'tokensIn',
          difference: 21.5,
          range: [15, 27.25],
          verdict: 'harms',
          margin: 10,
          taskCount: 3,
          runCount: 30,
        },
        {
          metric: 'cacheWrite',
          difference: 0.6,
          range: [-0.3, 1.5],
          verdict: 'placebo',
          margin: 10,
          taskCount: 2,
          runCount: 20,
          excludedTasks: [{ taskId: 'webhook-signature', reason: 'too_few_runs' }],
        },
        {
          metric: 'turns',
          difference: -1.25,
          range: [-2.6, 0.31],
          verdict: 'no_evidence',
          margin: null,
          taskCount: 3,
          runCount: 30,
        },
        {
          metric: 'checklist',
          difference: 0,
          range: [0, 0],
          verdict: 'no_evidence',
          margin: null,
          runsNeeded: 2,
          taskCount: 0,
          runCount: 0,
          excludedTasks: [
            { taskId: 'refund-rounding', reason: 'too_few_runs' },
            { taskId: 'webhook-signature', reason: 'too_few_runs' },
          ],
        },
        {
          metric: 'winRate',
          difference: -0.083,
          range: [-0.5, 0.25],
          verdict: 'no_evidence',
          margin: null,
          runsNeeded: 40,
          taskCount: 3,
          runCount: 15,
        },
      ],
    },
  ],
});

describe('terminal card and report card', () => {
  it('print the same difference, range, verdict, note and exclusions for every row', () => {
    const [card] = results.verdictCards;
    if (card === undefined) throw new Error('no card');
    const lines = renderCard(card, results, plain).split('\n').slice(1, -1);

    // What the report's card renders for each row, cell by cell, from the same formatters.
    const expected = card.rows.flatMap((row) => {
      const note = formatRunsNeededNote(row);
      const excluded = formatExcludedTasks(row);
      const cells = [
        METRICS[row.metric].label,
        formatDifference(row),
        formatRange(row),
        formatVerdict(row.verdict),
        ...(note === undefined ? [] : [note]),
      ];
      return excluded === undefined ? [cells] : [cells, [excluded]];
    });
    // Terminal cells are padded with at least two spaces; no cell holds two spaces in a row.
    expect(lines.map((line) => line.trim().split(/ {2,}/))).toEqual(expected);
  });
});
