import { describe, expect, it } from 'vitest';
import { TaskId, taskIdFromTitle } from '../index.js';

describe('taskIdFromTitle', () => {
  it.each([
    ['Fix refund rounding', 'fix-refund-rounding'],
    ['fix: refund rounding (10.005 → 10.01)', 'fix-refund-rounding-10-005-10-01'],
    ['Café crème', 'cafe-creme'],
    ['Über_cool   STUFF', 'uber-cool-stuff'],
    ['--leading and trailing--', 'leading-and-trailing'],
    ['42 is the answer', '42-is-the-answer'],
    ['feat(cli)!: add --json', 'feat-cli-add-json'],
  ])('%j becomes %j', (title, expected) => {
    expect(taskIdFromTitle(title)).toBe(expected);
  });

  it('keeps at most 48 characters and never ends on a dash', () => {
    expect(taskIdFromTitle(`${'a'.repeat(47)} bcd`)).toBe('a'.repeat(47));
    expect(taskIdFromTitle('word '.repeat(20))).toBe(
      'word-word-word-word-word-word-word-word-word-wor',
    );
  });

  it.each(['', '   ', '---', '日本語', '!!!'])('is undefined for %j', (title) => {
    expect(taskIdFromTitle(title)).toBeUndefined();
  });

  it('returns a valid task id', () => {
    for (const title of ['Fix refund rounding', 'Café crème', 'x'.repeat(100)]) {
      expect(TaskId.safeParse(taskIdFromTitle(title)).success).toBe(true);
    }
  });
});
