import { z } from 'zod';
import { TaskId } from '../kernel/ids.js';
import type { MarginKey } from './suite.js';

/** One measured quantity per run that gets a difference, a range and a verdict. */
export const Metric = z.enum([
  'passRate',
  'costUsd',
  'tokensIn',
  'tokensOut',
  'cacheRead',
  'cacheWrite',
  'turns',
  'durationMs',
  'checklist',
  'winRate',
]);
export type Metric = z.infer<typeof Metric>;

/**
 * How a difference is expressed: `pts` percentage points, `percent` relative to the control
 * value, `absolute` in the metric's own unit.
 */
export const MetricUnit = z.enum(['pts', 'percent', 'absolute']);
export type MetricUnit = z.infer<typeof MetricUnit>;

export interface MetricInfo {
  readonly label: string;
  readonly higherIsBetter: boolean;
  readonly unit: MetricUnit;
  /**
   * The suite margin that applies, in the metric's unit. `null` means no margin is defined, so
   * the metric can be helps, harms or no evidence but never placebo.
   */
  readonly margin: MarginKey | null;
  /**
   * When set, each task's treatment mean is compared with this fixed value instead of the
   * control arm's runs, and only treatment runs count. Win rate uses 0.5: a treatment that wins
   * half its comparisons makes no difference.
   */
  readonly reference?: number;
}

/** In card order: pass rate and cost lead by convention (brief §10). */
export const METRICS: Readonly<Record<Metric, MetricInfo>> = {
  passRate: { label: 'pass rate', higherIsBetter: true, unit: 'pts', margin: 'passRate' },
  costUsd: { label: 'cost', higherIsBetter: false, unit: 'percent', margin: 'cost' },
  tokensIn: { label: 'tokens in', higherIsBetter: false, unit: 'percent', margin: 'tokens' },
  tokensOut: { label: 'tokens out', higherIsBetter: false, unit: 'percent', margin: 'tokens' },
  cacheRead: { label: 'cache read', higherIsBetter: false, unit: 'percent', margin: 'tokens' },
  cacheWrite: { label: 'cache write', higherIsBetter: false, unit: 'percent', margin: 'tokens' },
  turns: { label: 'turns', higherIsBetter: false, unit: 'absolute', margin: null },
  durationMs: { label: 'duration', higherIsBetter: false, unit: 'percent', margin: 'duration' },
  checklist: { label: 'checklist', higherIsBetter: true, unit: 'absolute', margin: null },
  winRate: { label: 'win rate', higherIsBetter: true, unit: 'pts', margin: null, reference: 0.5 },
};

/** The single tag on a metric row (brief §10, ADR 0005). */
export const Verdict = z.enum(['helps', 'harms', 'placebo', 'no_evidence']);
export type Verdict = z.infer<typeof Verdict>;

/**
 * Runs with a value an arm needs on a task before the task counts toward a metric row: with one
 * run, every resample draws the same value and the range collapses to a point.
 */
export const MIN_RUNS_PER_ARM = 2;

/**
 * A task left out of a metric row, and why: `control_zero` for a `percent` metric whose control
 * mean is zero (the difference is undefined), `too_few_runs` when an arm the row compares has
 * fewer than {@link MIN_RUNS_PER_ARM} runs with a value on it.
 */
export const ExcludedTask = z.strictObject({
  taskId: TaskId,
  reason: z.enum(['control_zero', 'too_few_runs']),
});
export type ExcludedTask = z.infer<typeof ExcludedTask>;

/** One line of a verdict card: treatment minus control for one metric. */
export const MetricRow = z
  .strictObject({
    metric: Metric,
    /** Treatment minus control, in the metric's unit, summarized across tasks. */
    difference: z.number(),
    /** Plausible spread of the difference, by resampling. */
    range: z.tuple([z.number(), z.number()]),
    verdict: Verdict,
    /** The margin used, in the metric's unit; null when the metric has none. */
    margin: z.number().positive().nullable(),
    /** Estimated runs per task to reach a verdict; only on `no_evidence` rows. */
    runsNeeded: z.int().positive().optional(),
    /** Tasks that contributed (dead tasks excluded). */
    taskCount: z.int().nonnegative(),
    /** Runs that contributed, both arms. */
    runCount: z.int().nonnegative(),
    /** Tasks with values that this row leaves out, with the reason; absent when none. */
    excludedTasks: z.array(ExcludedTask).optional(),
    /**
     * Set when every counted run gave the same value in both arms, task by task: the difference
     * is 0 and the range [0, 0]. More runs would not change a thing, so no `runsNeeded`.
     */
    identical: z.literal(true).optional(),
  })
  .refine(({ range: [lo, hi] }) => lo <= hi, {
    error: 'range must be [low, high]',
    path: ['range'],
  })
  .refine((row) => row.runsNeeded === undefined || row.verdict === 'no_evidence', {
    error: 'runsNeeded is only set on no_evidence rows',
    path: ['runsNeeded'],
  })
  .refine(
    (row) =>
      row.identical === undefined ||
      (row.taskCount > 0 &&
        row.difference === 0 &&
        row.range[0] === 0 &&
        row.range[1] === 0 &&
        row.runsNeeded === undefined),
    {
      error:
        'identical is only set on rows with tasks, a difference of 0, a range of [0, 0] and no runsNeeded',
      path: ['identical'],
    },
  );
export type MetricRow = z.infer<typeof MetricRow>;
