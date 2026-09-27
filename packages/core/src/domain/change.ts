import { z } from 'zod';

/**
 * The diff between the run folder after the agent finished and the snapshot plus variant patch
 * (ADR 0012: `git diff HEAD` plus untracked files). The variant's own files are never part of it.
 */
export const Change = z.strictObject({
  /** Unified diff. */
  diff: z.string(),
  /** Paths touched, relative to the run folder, sorted. */
  files: z.array(z.string()),
  /** Byte length of `diff`. */
  bytes: z.int().nonnegative(),
});
export type Change = z.infer<typeof Change>;
