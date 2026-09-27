import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.js';
import { err, ok } from './result.js';

describe('Result', () => {
  it('wraps values and errors', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('nope')).toEqual({ ok: false, error: 'nope' });
  });
});

describe('systemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
