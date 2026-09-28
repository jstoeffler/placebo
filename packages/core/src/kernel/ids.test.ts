import { describe, expect, it } from 'vitest';
import { CommitSha, Sha256, TaskId, VariantName } from './ids.js';

describe('ids', () => {
  it('accepts slugs for task ids and variant names', () => {
    expect(TaskId.parse('refund-rounding')).toBe('refund-rounding');
    expect(VariantName.parse('always_run_tests')).toBe('always_run_tests');
  });

  it.each(['', 'Refund', '-x', 'a b'])('rejects task id %j', (id) => {
    expect(TaskId.safeParse(id).success).toBe(false);
  });

  it.each(['2x', '0', '-x', 'Rules', ''])('rejects variant name %j', (name) => {
    expect(VariantName.safeParse(name).error?.issues.map((issue) => issue.message)).toEqual([
      'variant name must start with a lowercase letter, so it never reads as a number or a run count, followed by lowercase letters, digits, "-" or "_"',
    ]);
  });

  it('reserves "control" as a variant name', () => {
    const result = VariantName.safeParse('control');
    expect(result.error?.issues[0]?.message).toBe('variant name "control" is reserved');
  });

  it('accepts full SHA-1 and SHA-256 commit ids only', () => {
    expect(CommitSha.safeParse('a'.repeat(40)).success).toBe(true);
    expect(CommitSha.safeParse('a'.repeat(64)).success).toBe(true);
    expect(CommitSha.safeParse('3f9a1c2e').success).toBe(false);
    expect(Sha256.safeParse('A'.repeat(64)).success).toBe(false);
  });
});
