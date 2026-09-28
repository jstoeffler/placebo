import { describe, expect, it, vi } from 'vitest';
import type { Random } from '../../kernel/random.js';
import { RunnerInfraError, type RunnerInfraReason } from '../../ports/runner.js';
import { backoffMs, infraMessage, isLastAttempt, sleep } from './retry.js';

const fixed = (value: number): Random => ({
  next: () => value,
  int: () => 0,
  shuffle: (items) => [...items],
});

describe('backoffMs', () => {
  it('doubles from one second, caps at a minute, and adds up to a quarter of jitter', () => {
    expect([0, 1, 2, 5, 6, 10].map((attempt) => backoffMs(attempt, undefined, fixed(0)))).toEqual([
      1000, 2000, 4000, 32000, 60000, 60000,
    ]);
    expect(backoffMs(0, undefined, fixed(0.999))).toBe(1249);
  });

  it("uses the server's retry hint when there is one", () => {
    expect(backoffMs(3, 90_000, fixed(0))).toBe(90_000);
    expect(backoffMs(3, 0, fixed(0.5))).toBe(0);
  });
});

describe('sleep', () => {
  it('waits the given time', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = sleep(1000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns early when the signal aborts, or at once when it already did', async () => {
    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined();
  });
});

describe('isLastAttempt', () => {
  const error = (reason: RunnerInfraReason) => new RunnerInfraError(reason, 'x');

  it('retries transient errors until attempts run out', () => {
    for (const reason of ['spawn_failed', 'rate_limited', 'network', 'other'] as const) {
      expect(isLastAttempt(error(reason), 0, 5)).toBe(false);
      expect(isLastAttempt(error(reason), 4, 5)).toBe(true);
    }
  });

  it('never retries auth or a rejected request', () => {
    expect(isLastAttempt(error('auth'), 0, 5)).toBe(true);
    expect(isLastAttempt(error('invalid_request'), 0, 5)).toBe(true);
  });
});

describe('infraMessage', () => {
  it('names the Claude Code version and asks to report a rejected request', () => {
    const rejected = new RunnerInfraError('invalid_request', 'Invalid schema');
    expect(infraMessage(rejected, '2.1.283')).toBe(
      'Claude Code 2.1.283 rejected the request Placebo built: Invalid schema. This is a Placebo bug or an incompatibility with this Claude Code version; please report it at https://github.com/jstoeffler/placebo/issues with this message.',
    );
    expect(infraMessage(rejected)).toMatch(/^Claude Code rejected the request Placebo built/);
  });

  it('passes other errors through', () => {
    expect(infraMessage(new RunnerInfraError('network', 'ECONNRESET'))).toBe('ECONNRESET');
  });
});
