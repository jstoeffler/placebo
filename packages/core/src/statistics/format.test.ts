import { describe, expect, it } from 'vitest';
import type { Metric } from '../domain/metrics.js';
import {
  formatDifference,
  formatRange,
  formatRunsNeeded,
  formatSigned,
  formatVerdict,
} from './format.js';

const row = (metric: Metric, difference: number) => ({ metric, difference });

describe('formatDifference', () => {
  it('prints the examples of the brief', () => {
    expect(formatDifference(row('passRate', -7))).toBe('-7 pts');
    expect(formatDifference(row('costUsd', -18))).toBe('-18 %');
    expect(formatDifference(row('turns', -1.2))).toBe('-1.2');
    expect(formatDifference(row('checklist', 0.3))).toBe('+0.3');
  });

  it('keeps one decimal below 10 and none from 10 up for pts and percent', () => {
    expect(formatDifference(row('passRate', 3.14))).toBe('+3.1 pts');
    expect(formatDifference(row('passRate', 12.6))).toBe('+13 pts');
    expect(formatDifference(row('durationMs', -9.96))).toBe('-10 %');
    expect(formatDifference(row('tokensIn', 0.04))).toBe('0 %');
  });

  it('prints zero without a sign', () => {
    expect(formatDifference(row('passRate', 0))).toBe('0 pts');
    expect(formatDifference(row('turns', -0))).toBe('0');
  });
});

describe('formatSigned for absolute values', () => {
  it('keeps at most two decimals from 1 up and two significant digits below 1', () => {
    expect(formatSigned(1.234, 'absolute')).toBe('+1.23');
    expect(formatSigned(1234.5, 'absolute')).toBe('+1234.5');
    expect(formatSigned(-2, 'absolute')).toBe('-2');
    expect(formatSigned(0.0346, 'absolute')).toBe('+0.035');
    expect(formatSigned(-0.3, 'absolute')).toBe('-0.3');
  });
});

describe('formatRange', () => {
  it('prints both ends with signs and no unit', () => {
    expect(formatRange({ metric: 'passRate', range: [-30, 15] })).toBe('[-30, +15]');
    expect(formatRange({ metric: 'turns', range: [-1.25, 0] })).toBe('[-1.25, 0]');
  });
});

describe('formatVerdict', () => {
  it('uses the words of the brief', () => {
    expect(formatVerdict('helps')).toBe('helps');
    expect(formatVerdict('harms')).toBe('harms');
    expect(formatVerdict('placebo')).toBe('placebo');
    expect(formatVerdict('no_evidence')).toBe('no evidence');
  });
});

describe('formatRunsNeeded', () => {
  it('prints the estimate, or "more than 1000" when it is above the cap', () => {
    expect(formatRunsNeeded({ verdict: 'no_evidence', runsNeeded: 12, taskCount: 3 })).toBe('12');
    expect(formatRunsNeeded({ verdict: 'no_evidence', taskCount: 3 })).toBe('more than 1000');
  });

  it('prints nothing on decided rows and on rows without tasks', () => {
    expect(formatRunsNeeded({ verdict: 'helps', taskCount: 3 })).toBeUndefined();
    expect(formatRunsNeeded({ verdict: 'no_evidence', taskCount: 0 })).toBeUndefined();
  });
});
