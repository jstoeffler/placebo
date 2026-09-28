import { describe, expect, it } from 'vitest';
import {
  checklistGrade,
  commandGrade,
  comparisonGrade,
  makeRun,
  sampleGrades,
} from '../testing/fixtures.js';
import { mean, metricValue } from './values.js';

describe('mean', () => {
  it('averages the values', () => {
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNaN();
  });

  it('gives exactly the value of a list of one repeated value, without rounding drift', () => {
    expect(0.7 + 0.7 + 0.7).not.toBe(2.1);
    expect(mean([0.7, 0.7, 0.7])).toBe(0.7);
  });
});

const review = {
  grader: { type: 'review', index: null },
  kind: 'review',
  score: 5,
  detail: { type: 'review', reviewId: 'rev-1', reviewer: 'julien' },
};

describe('metricValue', () => {
  it('reads measurement metrics straight from measurements', () => {
    const run = makeRun({
      measurements: {
        costUsd: 0.5,
        turns: 7,
        durationMs: 1234,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    });
    expect(metricValue(run, 'costUsd')).toBe(0.5);
    expect(metricValue(run, 'turns')).toBe(7);
    expect(metricValue(run, 'durationMs')).toBe(1234);
    expect(metricValue(run, 'tokensIn')).toBe(1);
    expect(metricValue(run, 'tokensOut')).toBe(2);
    expect(metricValue(run, 'cacheRead')).toBe(3);
    expect(metricValue(run, 'cacheWrite')).toBe(4);
  });

  describe('passRate', () => {
    it('is 1 when completed and every deterministic grade passed', () => {
      const run = makeRun({ grades: [commandGrade(true), commandGrade(true)] });
      expect(metricValue(run, 'passRate')).toBe(1);
    });

    it('is 0 when one deterministic grade failed', () => {
      const run = makeRun({ grades: [commandGrade(true), commandGrade(false)] });
      expect(metricValue(run, 'passRate')).toBe(0);
    });

    it('is 0 when the run did not complete, even if graders passed', () => {
      const run = makeRun({ outcome: 'crashed', grades: [commandGrade(true)] });
      expect(metricValue(run, 'passRate')).toBe(0);
    });

    it('is undefined when the task has no deterministic graders', () => {
      const run = makeRun({ grades: [checklistGrade(2)] });
      expect(metricValue(run, 'passRate')).toBeUndefined();
    });

    it('is 0 for an ungraded run of a task known to have deterministic graders', () => {
      const run = makeRun({ outcome: 'crashed', grades: [] });
      expect(metricValue(run, 'passRate', { deterministicGraders: true })).toBe(0);
      expect(metricValue(run, 'passRate', { deterministicGraders: false })).toBeUndefined();
    });
  });

  describe('checklist', () => {
    it('is the mean score of checklist judge grades, ignoring reviews and other graders', () => {
      const run = makeRun({
        grades: [checklistGrade(2), checklistGrade(3), sampleGrades[0], review],
      });
      expect(metricValue(run, 'checklist')).toBe(2.5);
    });

    it('is undefined without checklist grades', () => {
      expect(metricValue(makeRun({ grades: [review] }), 'checklist')).toBeUndefined();
    });
  });

  describe('winRate', () => {
    it('is 1 when the treatment run was preferred and 0 when not', () => {
      const won = makeRun({ arm: 'none', grades: [comparisonGrade(true)] });
      const lost = makeRun({ arm: 'none', grades: [comparisonGrade(false)] });
      expect(metricValue(won, 'winRate')).toBe(1);
      expect(metricValue(lost, 'winRate')).toBe(0);
    });

    it('is undefined on control runs, even with comparison grades', () => {
      const run = makeRun({ arm: 'control', grades: [comparisonGrade(true)] });
      expect(metricValue(run, 'winRate')).toBeUndefined();
    });

    it('is undefined on treatment runs without comparison grades', () => {
      expect(metricValue(makeRun({ arm: 'none' }), 'winRate')).toBeUndefined();
    });
  });
});
