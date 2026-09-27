import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTING_SOURCES, RunnerInfraError } from './runner.js';

describe('RunnerInfraError', () => {
  it('carries the reason, retry hint and cause', () => {
    const cause = new Error('ECONNRESET');
    const error = new RunnerInfraError('rate_limited', 'rate limited', {
      cause,
      retryAfterMs: 30_000,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RunnerInfraError');
    expect(error.reason).toBe('rate_limited');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.cause).toBe(cause);
  });

  it('works without options', () => {
    const error = new RunnerInfraError('spawn_failed', 'ENOENT claude');
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});

describe('DEFAULT_SETTING_SOURCES', () => {
  it('loads project settings only (ADR 0004)', () => {
    expect(DEFAULT_SETTING_SOURCES).toEqual(['project']);
  });
});
