import type { Random } from '../../kernel/random.js';
import type { RunnerInfraError } from '../../ports/runner.js';

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

/**
 * Whether the attempt that just failed with `error` (0 for the first) is the last one: attempts
 * ran out, or the error is `auth`, which no retry can fix.
 */
export function isLastAttempt(
  error: RunnerInfraError,
  attempt: number,
  maxInfraAttempts: number,
): boolean {
  return error.reason === 'auth' || attempt + 1 >= maxInfraAttempts;
}

/**
 * What an experiment ending on `error` says: the error itself, and for `auth` how to log in,
 * since Placebo uses whatever Claude Code auth the machine already has (ADR 0003).
 */
export function infraMessage(error: RunnerInfraError): string {
  if (error.reason !== 'auth') return error.message;
  return `Claude Code could not authenticate or bill this account: ${error.message}. Run \`claude\` once interactively and log in, or set ANTHROPIC_API_KEY, then run the experiment again.`;
}
