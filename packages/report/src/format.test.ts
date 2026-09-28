import { describe, expect, it } from 'vitest';
import { formatBytes, formatPlain, formatShare, formatTimestamp } from './format.js';

describe('report-only formatting', () => {
  it('formats shares as percentages with at most one decimal', () => {
    expect(formatShare(0.6)).toBe('60 %');
    expect(formatShare(0)).toBe('0 %');
    expect(formatShare(1 / 12)).toBe('8.3 %');
  });

  it('formats plain numbers with at most two decimals', () => {
    expect(formatPlain(3.14159)).toBe('3.14');
    expect(formatPlain(14)).toBe('14');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(4200)).toBe('4.2 KB');
    expect(formatBytes(1_300_000)).toBe('1.3 MB');
  });

  it('formats timestamps in UTC to the minute', () => {
    expect(formatTimestamp('2026-09-27T14:03:59.000Z')).toBe('2026-09-27 14:03 UTC');
    expect(formatTimestamp('not a date')).toBe('not a date');
  });
});
