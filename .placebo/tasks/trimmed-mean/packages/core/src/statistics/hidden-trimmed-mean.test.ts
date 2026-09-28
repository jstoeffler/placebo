import { describe, expect, it } from 'vitest';
import { trimmedMean } from '../index.js';

describe('trimmedMean', () => {
  it.each([
    [[1, 2, 3, 4, 100], 0.2, 3],
    [[100, 4, 1, 3, 2], 0.2, 3],
    [[5, 1, 3], 0, 3],
    [[1, 2, 3, 4], 0.25, 2.5],
    [[1, 2, 3, 4], 0.49, 2.5],
    [[1, 2, 3, 4], 0.24, 2.5],
    [[7], 0.4, 7],
    [[-10, 0, 0, 0, 1000, 2, 1, -3, 5, 4], 0.1, 1.125],
  ])('trims %j by %d to %d', (values, proportion, expected) => {
    expect(trimmedMean(values, proportion)).toBeCloseTo(expected, 12);
  });

  it('is NaN for no values', () => {
    expect(trimmedMean([], 0.1)).toBeNaN();
  });

  it('leaves its input untouched', () => {
    const values = [3, 1, 2];
    trimmedMean(values, 0.34);
    expect(values).toEqual([3, 1, 2]);
  });

  it.each([0.5, 0.75, 1, -0.1, Number.NaN])('rejects a proportion of %d with a RangeError', (p) => {
    expect(() => trimmedMean([1, 2, 3], p)).toThrow(RangeError);
  });
});
