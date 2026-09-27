import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCount,
  formatCurrency,
  formatDifference,
  formatDuration,
  formatPlain,
  formatRange,
  formatRunsNeeded,
  formatShare,
  formatTimestamp,
} from './format.js';

describe('formatDifference', () => {
  it.each([
    [-7, 'pts', '-7.0 pts'],
    [-30, 'pts', '-30 pts'],
    [15.4, 'pts', '+15 pts'],
    [9.94, 'pts', '+9.9 pts'],
    [9.96, 'pts', '+10 pts'],
    [-18.2, 'percent', '-18 %'],
    [-0.04, 'percent', '0.0 %'],
    [0, 'percent', '0.0 %'],
    [2.345, 'percent', '+2.3 %'],
    [-1.2, 'absolute', '-1.2'],
    [-0.4, 'absolute', '-0.4'],
    [0.125, 'absolute', '+0.13'],
    [3, 'absolute', '+3'],
    [-12.5, 'absolute', '-12.5'],
    [-0.001, 'absolute', '0'],
  ] as const)('%d %s is %s', (value, unit, expected) => {
    expect(formatDifference(value, unit)).toBe(expected);
  });
});

describe('formatRange', () => {
  it('signs both ends and drops the unit', () => {
    expect(formatRange([-30, 15], 'pts')).toBe('[-30, +15]');
    expect(formatRange([-2.6, 0.3], 'absolute')).toBe('[-2.6, +0.3]');
    expect(formatRange([-24.4, -12.1], 'percent')).toBe('[-24, -12]');
    expect(formatRange([-9.87, 4.2], 'percent')).toBe('[-9.9, +4.2]');
  });
});

describe('formatRunsNeeded', () => {
  it('estimates up to 1000 and says "more than" above', () => {
    expect(formatRunsNeeded(12)).toBe('(≈12 runs/task to decide)');
    expect(formatRunsNeeded(1000)).toBe('(≈1000 runs/task to decide)');
    expect(formatRunsNeeded(1001)).toBe('(more than 1000 runs/task)');
  });
});

describe('plain values', () => {
  it('formats currency with two decimals and grouping', () => {
    expect(formatCurrency(0.42)).toBe('$0.42');
    expect(formatCurrency(0.005)).toBe('$0.01');
    expect(formatCurrency(1204)).toBe('$1,204.00');
  });

  it('groups counts with commas', () => {
    expect(formatCount(12345)).toBe('12,345');
    expect(formatCount(999.6)).toBe('1,000');
  });

  it('formats durations', () => {
    expect(formatDuration(800)).toBe('0.8 s');
    expect(formatDuration(12_300)).toBe('12.3 s');
    expect(formatDuration(59_960)).toBe('1 m 00 s');
    expect(formatDuration(64_000)).toBe('1 m 04 s');
    expect(formatDuration(7_380_000)).toBe('2 h 03 m');
  });

  it('formats shares, plain numbers, bytes and timestamps', () => {
    expect(formatShare(0.6)).toBe('60 %');
    expect(formatShare(0)).toBe('0 %');
    expect(formatShare(1 / 12)).toBe('8.3 %');
    expect(formatPlain(3.14159)).toBe('3.14');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(4200)).toBe('4.2 KB');
    expect(formatBytes(1_300_000)).toBe('1.3 MB');
    expect(formatTimestamp('2026-09-27T14:03:59.000Z')).toBe('2026-09-27 14:03 UTC');
    expect(formatTimestamp('not a date')).toBe('not a date');
  });
});
