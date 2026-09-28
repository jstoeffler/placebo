import { describe, expect, it } from 'vitest';
import { formatTokensCompact } from '../index.js';

describe('formatTokensCompact', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [812, '812'],
    [999, '999'],
    [12.4, '12'],
    [999.6, '1k'],
    [1000, '1k'],
    [1234, '1.2k'],
    [12_345, '12.3k'],
    [100_000, '100k'],
    [999_949, '999.9k'],
    [999_960, '1M'],
    [1_000_000, '1M'],
    [1_260_000, '1.3M'],
    [42_000_000, '42M'],
    [999_960_000, '1B'],
    [1_234_000_000, '1.2B'],
    [5_000_000_000_000, '5000B'],
  ])('%d prints as %s', (count, expected) => {
    expect(formatTokensCompact(count)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %d with a RangeError', (count) => {
    expect(() => formatTokensCompact(count)).toThrow(RangeError);
  });

  it('is exported with the number formatting the report shares', async () => {
    const format = await import('../format.js');
    expect(format.formatTokensCompact(12_345)).toBe('12.3k');
  });
});
