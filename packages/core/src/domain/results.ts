import { z } from 'zod';
import { TaskId, VariantName } from '../kernel/ids.js';
import { Arm, ArmName } from './arm.js';
import { Experiment } from './experiment.js';
import { Metric, MetricRow } from './metrics.js';
import { Review } from './review.js';
import { Run } from './run.js';
import { GRADER_TYPES, Margins } from './suite.js';
import { Warning } from './warnings.js';

/** Bump on any breaking change to `Results`; the report refuses versions it does not know. */
export const RESULTS_SCHEMA_VERSION = 1;

export const TaskSummary = z.strictObject({
  id: TaskId,
  prompt: z.string(),
  graders: z.array(
    z.strictObject({
      index: z.int().nonnegative(),
      type: z.enum(GRADER_TYPES),
      /** Human-readable one-liner, e.g. `command: pnpm vitest run tests/hidden/refund.spec.ts`. */
      label: z.string(),
    }),
  ),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

/** One task under one arm: run count and the per-run mean of each metric (null if undefined). */
export const TaskArmBreakdown = z.strictObject({
  taskId: TaskId,
  arm: ArmName,
  runCount: z.int().nonnegative(),
  /**
   * Per metric, in the unit of a single run rather than the unit of its difference: pass rate
   * and win rate are shares in [0, 1], cost is USD, durations are ms, tokens and turns are counts,
   * checklist is a count of yes.
   */
  means: z.partialRecord(Metric, z.number().nullable()),
});
export type TaskArmBreakdown = z.infer<typeof TaskArmBreakdown>;

/** The verdict card of one treatment against control. */
export const VerdictCard = z.strictObject({
  variant: VariantName,
  rows: z.array(MetricRow),
});
export type VerdictCard = z.infer<typeof VerdictCard>;

/**
 * The `results.json` contract between cli and report (ADR 0013), also embedded in
 * `report.html`. Versioned by `schemaVersion`.
 */
export const Results = z.strictObject({
  schemaVersion: z.literal(RESULTS_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  experiment: Experiment,
  arms: z.array(Arm),
  margins: Margins,
  tasks: z.array(TaskSummary),
  runs: z.array(Run),
  /** One card per treatment, in suite order. */
  verdictCards: z.array(VerdictCard),
  breakdown: z.array(TaskArmBreakdown),
  /** Tasks where every arm scored zero; excluded from verdicts. */
  deadTasks: z.array(TaskId),
  warnings: z.array(Warning),
  reviews: z.array(Review),
});
export type Results = z.infer<typeof Results>;
