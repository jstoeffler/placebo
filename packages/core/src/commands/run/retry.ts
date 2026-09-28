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

/** Where a request Claude Code rejects gets reported: it is a bug in Placebo or a version skew. */
const ISSUES_URL = 'https://github.com/jstoeffler/placebo/issues';

/**
 * Whether the attempt that just failed with `error` (0 for the first) is the last one: attempts
 * ran out, or the error is `auth` or `invalid_request`, which no retry can fix.
 */
export function isLastAttempt(
  error: RunnerInfraError,
  attempt: number,
  maxInfraAttempts: number,
): boolean {
  return (
    error.reason === 'auth' || error.reason === 'invalid_request' || attempt + 1 >= maxInfraAttempts
  );
}

/**
 * What an experiment ending on `error` says: the error itself; for `auth` how to log in, since
 * Placebo uses whatever Claude Code auth the machine already has (ADR 0003); for
 * `invalid_request` that Claude Code rejected the request Placebo built, with the installed
 * Claude Code version when known, and where to report it.
 */
export function infraMessage(error: RunnerInfraError, claudeCodeVersion?: string): string {
  switch (error.reason) {
    case 'auth':
      return `Claude Code could not authenticate or bill this account: ${error.message}. Run \`claude\` once interactively and log in, or set ANTHROPIC_API_KEY, then run the experiment again.`;
    case 'invalid_request': {
      const version =
        claudeCodeVersion === undefined ? 'Claude Code' : `Claude Code ${claudeCodeVersion}`;
      return `${version} rejected the request Placebo built: ${error.message}. This is a Placebo bug or an incompatibility with this Claude Code version; please report it at ${ISSUES_URL} with this message.`;
    }
    default:
      return error.message;
  }
}
