import { z } from 'zod';
import { TokenUsage } from './events.js';

const Count = z.int().nonnegative();

/** What is measured per run (brief §8), derived from the events and the change. */
export const Measurements = z.strictObject({
  tokens: TokenUsage,
  /** As reported by Claude Code; an estimate on subscriptions. */
  costUsd: z.number().nonnegative(),
  turns: Count,
  durationMs: z.number().nonnegative(),
  apiDurationMs: z.number().nonnegative(),
  toolCalls: z.strictObject({ total: Count, byTool: z.record(z.string(), Count) }),
  /** Distinct files the agent read. */
  filesRead: Count,
  bytesRead: Count,
  /** Grep, Glob and similar calls: exploration effort. */
  searchCalls: Count,
  /** Size of the change in bytes of unified diff. */
  changeBytes: Count,
  filesTouched: Count,
});
export type Measurements = z.infer<typeof Measurements>;
