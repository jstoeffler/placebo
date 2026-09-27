import type { Random } from '../../kernel/random.js';

/** The first wait after an infrastructure error, doubled on every further attempt. */
const BASE_BACKOFF_MS = 1_000;
/** The longest computed wait; a server's `retryAfterMs` may ask for more. */
const MAX_BACKOFF_MS = 60_000;
/** Jitter is up to this fraction of the wait, so parallel runs do not retry in lockstep. */
const JITTER_FRACTION = 0.25;

/** Attempts per run (and per grading or comparison step) before the experiment ends. */
export const DEFAULT_MAX_INFRA_ATTEMPTS = 5;

/**
 * How long to wait after failed attempt `attempt` (0 for the first failure): the server's
 * `retryAfterMs` when it gave one, otherwise `min(1000 × 2^attempt, 60000)`, plus a jitter of up
 * to a quarter of that drawn from `random`.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: Random,
): number {
  const base = retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.floor(random.next() * base * JITTER_FRACTION);
}

/** Waits `ms`, or less if `signal` aborts first. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
