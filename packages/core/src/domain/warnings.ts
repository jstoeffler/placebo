import { z } from 'zod';
import { TaskId, VariantName } from '../kernel/ids.js';

/** Below this many tasks, results describe these tasks, not the repo (brief §13.5). */
export const FEW_TASKS_THRESHOLD = 5;

/** The ways an experiment can lie that the tool detects and shows (brief §13). */
export const Warning = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('few_tasks'),
    taskCount: z.int().nonnegative(),
    threshold: z.int().positive(),
  }),
  z.strictObject({ type: z.literal('judge_equals_subject'), model: z.string() }),
  z.strictObject({
    type: z.literal('patch_outside_surface'),
    variant: VariantName,
    /** Paths the patch touches outside the configuration surface. */
    paths: z.array(z.string()).min(1),
  }),
  z.strictObject({ type: z.literal('dead_task'), taskId: TaskId }),
  z.strictObject({
    type: z.literal('isolation_residual'),
    /** Leaks project-only settings do not close (ADR 0004). */
    sources: z.array(z.enum(['global_config', 'managed_settings', 'claude_ai_connectors'])).min(1),
  }),
  z.strictObject({
    type: z.literal('ancestor_configuration'),
    /**
     * Absolute paths of `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` or `.claude/` in a directory
     * above the run folders; Claude Code loads them into every arm (ADR 0014).
     */
    paths: z.array(z.string()).min(1),
  }),
]);
export type Warning = z.infer<typeof Warning>;
export type WarningType = Warning['type'];
