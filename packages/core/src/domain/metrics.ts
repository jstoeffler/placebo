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
    /**
     * Tasks left out of this row because the difference is undefined on them: a `percent`
     * metric whose control mean is zero. Absent when none were left out.
     */
    excludedTasks: z.array(TaskId).optional(),
  })
  .refine(({ range: [lo, hi] }) => lo <= hi, {
    error: 'range must be [low, high]',
    path: ['range'],
  })
  .refine((row) => row.runsNeeded === undefined || row.verdict === 'no_evidence', {
    error: 'runsNeeded is only set on no_evidence rows',
    path: ['runsNeeded'],
  });
export type MetricRow = z.infer<typeof MetricRow>;
