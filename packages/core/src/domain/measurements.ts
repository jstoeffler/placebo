import { z } from 'zod';
import { TokenUsage } from './events.js';

const Count = z.int().nonnegative();

/** What is measured per run (brief §8), derived from the events and the change. */
export const Measurements = z.strictObject({
  tokens: TokenUsage,
  /**
   * As reported by Claude Code, plus an estimate for usage it reported after its last result;
   * an estimate on subscriptions.
   */
  costUsd: z.number().nonnegative(),
  /** Turns of the main loop. */
  turns: Count,
  /** Turns of subagents started by the `Agent` tool; absent from runs stored before it existed. */
  subagentTurns: Count.optional(),
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
