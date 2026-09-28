/**
 * A problem with how placebo was invoked or with what it was pointed at (bad flags, no suite, an
 * invalid suite): nothing ran, and the process exits with code 2. The message is printed as is,
 * one problem per line.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Exit codes (brief §11): completion regardless of verdicts, a failed experiment, a usage error. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
