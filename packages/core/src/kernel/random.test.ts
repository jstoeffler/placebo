import { describe, expect, it } from 'vitest';
import { createSeededRandom, MAX_SEED } from './random.js';

describe('createSeededRandom', () => {
  it('replays the same sequence from the same seed', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces a pinned sequence, identical on every platform', () => {
    const random = createSeededRandom(1);
    expect(Array.from({ length: 3 }, () => random.next())).toMatchInlineSnapshot(`
      [
        0.6270739405881613,
        0.002735721180215478,
        0.5274470399599522,
      ]
    `);
  });

  it('differs between seeds', () => {
    expect(createSeededRandom(1).next()).not.toBe(createSeededRandom(2).next());
  });

  it('stays in [0, 1) and is roughly uniform', () => {
    const random = createSeededRandom(7);
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 40_000; i++) {
      const x = random.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      buckets[Math.floor(x * 4)]! += 1;
    }
    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(500);
  });

  it('accepts the seed bounds and rejects anything else', () => {
    expect(() => createSeededRandom(0)).not.toThrow();
    expect(() => createSeededRandom(MAX_SEED)).not.toThrow();
    for (const bad of [-1, MAX_SEED + 1, 1.5, Number.NaN]) {
      expect(() => createSeededRandom(bad)).toThrow(RangeError);
    }
  });

  describe('int', () => {
    it('returns integers in [min, max) covering the whole interval', () => {
      const random = createSeededRandom(3);
      const seen = new Set<number>();
      for (let i = 0; i < 1000; i++) {
        const n = random.int(-2, 3);
        expect(Number.isInteger(n)).toBe(true);
        seen.add(n);
      }
      expect([...seen].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
    });

    it.each([
      [1, 1],
      [2, 1],
      [0, 1.5],
    ])('rejects int(%d, %d)', (min, max) => {
      expect(() => createSeededRandom(1).int(min, max)).toThrow(RangeError);
    });
  });

  describe('shuffle', () => {
    it('returns a permutation and leaves the input untouched', () => {
      const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
      const out = createSeededRandom(9).shuffle(input);
      expect(out).not.toBe(input);
      expect([...out].sort((a, b) => a - b)).toEqual([...input]);
      expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('is deterministic per seed', () => {
      const items = ['a', 'b', 'c', 'd', 'e'];
      expect(createSeededRandom(5).shuffle(items)).toEqual(createSeededRandom(5).shuffle(items));
    });

    it('handles empty and single-item arrays', () => {
      expect(createSeededRandom(1).shuffle([])).toEqual([]);
      expect(createSeededRandom(1).shuffle(['x'])).toEqual(['x']);
    });
  });
});
