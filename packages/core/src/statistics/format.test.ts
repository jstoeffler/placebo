import { describe, expect, it } from 'vitest';
import type { Metric } from '../domain/metrics.js';
import {
  formatBytes,
  formatCurrency,
  formatDifference,
  formatDuration,
  formatMean,
  formatPlain,
  formatRange,
  formatRunsNeeded,
  formatRunsNeededNote,
  formatShare,
  formatSigned,
  formatTokens,
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

describe('formatRunsNeededNote', () => {
  it('prints the note of the card, or nothing where no estimate applies', () => {
    expect(formatRunsNeededNote({ verdict: 'no_evidence', runsNeeded: 12, taskCount: 3 })).toBe(
      '(≈12 runs/task to decide)',
    );
    expect(formatRunsNeededNote({ verdict: 'no_evidence', taskCount: 3 })).toBe(
      '(more than 1000 runs/task)',
    );
    expect(formatRunsNeededNote({ verdict: 'placebo', taskCount: 3 })).toBeUndefined();
  });
});

describe('formatCurrency', () => {
  it('prints US dollars with two decimals and comma grouping', () => {
    expect(formatCurrency(0.42)).toBe('$0.42');
    expect(formatCurrency(1204)).toBe('$1,204.00');
    expect(formatCurrency(0.005)).toBe('$0.01');
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(-0)).toBe('$0.00');
  });
});

describe('formatTokens', () => {
  it('rounds to a whole number and groups with commas', () => {
    expect(formatTokens(12345)).toBe('12,345');
    expect(formatTokens(999.6)).toBe('1,000');
    expect(formatTokens(0)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('prints seconds with one decimal under a minute', () => {
    expect(formatDuration(800)).toBe('0.8 s');
    expect(formatDuration(12_300)).toBe('12.3 s');
    expect(formatDuration(0)).toBe('0.0 s');
  });

  it('prints minutes and padded seconds up to an hour', () => {
    expect(formatDuration(59_960)).toBe('1 m 00 s');
    expect(formatDuration(64_000)).toBe('1 m 04 s');
    expect(formatDuration(3_599_000)).toBe('59 m 59 s');
  });

  it('prints hours and padded minutes from an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1 h 00 m');
    expect(formatDuration(7_380_000)).toBe('2 h 03 m');
  });
});

describe('per-run formatting', () => {
  it('formats shares as percentages with at most one decimal', () => {
    expect(formatShare(0.6)).toBe('60 %');
    expect(formatShare(0)).toBe('0 %');
    expect(formatShare(1 / 12)).toBe('8.3 %');
  });

  it('formats plain numbers with at most two decimals', () => {
    expect(formatPlain(3.14159)).toBe('3.14');
    expect(formatPlain(14)).toBe('14');
    expect(formatPlain(-0.001)).toBe('0');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(4200)).toBe('4.2 KB');
    expect(formatBytes(1_300_000)).toBe('1.3 MB');
    expect(formatBytes(2_100_000_000)).toBe('2.1 GB');
  });

  it.each<[Metric, number, string]>([
    ['passRate', 0.8, '80 %'],
    ['winRate', 0.5, '50 %'],
    ['costUsd', 0.123, '$0.12'],
    ['tokensIn', 12345.4, '12,345'],
    ['cacheWrite', 10, '10'],
    ['durationMs', 12_340, '12.3 s'],
    ['turns', 3.25, '3.3'],
    ['checklist', 2, '2'],
  ])('formats a %s mean of %d as %s', (metric, value, text) => {
    expect(formatMean(metric, value)).toBe(text);
  });
});
