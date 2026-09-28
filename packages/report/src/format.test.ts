import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './format.js';

describe('report-only formatting', () => {
  it('formats timestamps in UTC to the minute', () => {
    expect(formatTimestamp('2026-09-27T14:03:59.000Z')).toBe('2026-09-27 14:03 UTC');
    expect(formatTimestamp('not a date')).toBe('not a date');
  });
});
