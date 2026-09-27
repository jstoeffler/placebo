import { METRICS, type Metric, type MetricRow, type Verdict } from '../domain/metrics.js';
import type { Margins } from '../domain/suite.js';
import type { TaskId } from '../kernel/ids.js';
import type { Random } from '../kernel/random.js';
import { mean } from './values.js';

/** How many simulated re-runs of the experiment a range is read from, unless asked otherwise. */
export const DEFAULT_RESAMPLES = 1000;

/** Runs needed above this are not printed as a number; the report says "more than 1000". */
export const RUNS_NEEDED_CAP = 1000;

/** The per-run values of one metric on one task, per arm, in any order. */
export interface TaskSamples {
  readonly taskId: TaskId;
  readonly control: readonly number[];
  readonly treatment: readonly number[];
}

export interface MetricRowInput {
  readonly metric: Metric;
  /** One entry per task; dead tasks must already be left out. */
  readonly tasks: readonly TaskSamples[];
  readonly margins: Margins;
  readonly random: Random;
  /** Defaults to {@link DEFAULT_RESAMPLES}. Changes the range, never the difference. */
  readonly resamples?: number;
}

/**
 * One verdict-card line for one metric (brief §10).
 *
 * 1. Per task, the control mean `c` and treatment mean `t` give a task difference in the
 *    metric's unit: `pts` is `(t − c) × 100`, `percent` is `(t − c) / c × 100`, `absolute` is
 *    `t − c`. A metric with a `reference` (win rate) uses that fixed value as `c` and only
 *    treatment runs. A `percent` task whose control mean is 0 has no difference; it is left out
 *    and listed in `excludedTasks`. Tasks with no values in an arm are skipped silently: the
 *    metric does not exist there.
 * 2. The difference is the mean of the task differences, so every task weighs the same however
 *    many runs it has.
 * 3. The range comes from {@link resampleRange}, the verdict from {@link decideVerdict}, and
 *    `runsNeeded` (on `no_evidence` rows only) from {@link estimateRunsNeeded}.
 *
 * With no task left, the row is `no_evidence` with `taskCount` 0, difference 0 and range [0, 0].
 */
export function computeMetricRow(input: MetricRowInput): MetricRow {
  const { metric, margins, random } = input;
  const resamples = input.resamples ?? DEFAULT_RESAMPLES;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`resamples must be a positive integer, got ${String(resamples)}`);
  }
  const info = METRICS[metric];
  const margin = info.margin === null ? null : margins[info.margin];
  const reference = info.reference;

  const present = input.tasks.filter(
    (task) => task.treatment.length > 0 && (reference !== undefined || task.control.length > 0),
  );
  const included: TaskSamples[] = [];
  const excludedTasks: TaskId[] = [];
  for (const task of present) {
    const c = reference ?? mean(task.control);
    if (taskDifference(metric, c, mean(task.treatment)) === undefined) {
      excludedTasks.push(task.taskId);
    } else {
      included.push(task);
    }
  }
  const excluded = excludedTasks.length > 0 ? { excludedTasks } : {};

  if (included.length === 0) {
    return {
      metric,
      difference: 0,
      range: [0, 0],
      verdict: 'no_evidence',
      margin,
      taskCount: 0,
      runCount: 0,
      ...excluded,
    };
  }

  const difference = pointEstimate(metric, included, reference);
  const range = resampleRange({ metric, tasks: included, difference, random, resamples });
  const verdict = decideVerdict(range, info.higherIsBetter, margin);
  const armRuns = (task: TaskSamples): number =>
    task.treatment.length + (reference === undefined ? task.control.length : 0);
  const armCount = reference === undefined ? 2 : 1;
  const runCount = included.reduce((sum, task) => sum + armRuns(task), 0);
  const runsNeeded =
    verdict === 'no_evidence'
      ? estimateRunsNeeded({
          difference,
          range,
          margin,
          runsPerTask: runCount / armCount / included.length,
        })
      : undefined;

  return {
    metric,
    difference,
    range,
    verdict,
    margin,
    ...(runsNeeded === undefined ? {} : { runsNeeded }),
    taskCount: included.length,
    runCount,
    ...excluded,
  };
}

/** One task's difference in the metric's unit, or `undefined` for `percent` with `c === 0`. */
function taskDifference(metric: Metric, c: number, t: number): number | undefined {
  switch (METRICS[metric].unit) {
    case 'pts':
      return (t - c) * 100;
    case 'percent':
      return c === 0 ? undefined : ((t - c) / c) * 100;
    case 'absolute':
      return t - c;
  }
}

function pointEstimate(
  metric: Metric,
  tasks: readonly TaskSamples[],
  reference: number | undefined,
): number {
  const differences: number[] = [];
  for (const task of tasks) {
    const difference = taskDifference(
      metric,
      reference ?? mean(task.control),
      mean(task.treatment),
    );
    if (difference !== undefined) differences.push(difference);
  }
  return mean(differences);
}

interface ResampleInput {
  readonly metric: Metric;
  readonly tasks: readonly TaskSamples[];
  readonly difference: number;
  readonly random: Random;
  readonly resamples: number;
}

/**
 * The range of a difference by resampling (brief §10).
 *
 * Each resample simulates re-running the experiment from the real results: with more than one
 * task it first draws as many tasks as there are, with replacement; then within each drawn task
 * it draws each arm's runs with replacement, as many as that arm has (control first, then
 * treatment; only treatment for metrics with a `reference`). With one task only runs are drawn.
 * The resample's estimate is the mean of its task differences, computed exactly like the real
 * one; a drawn `percent` task whose resampled control mean is 0 is skipped in that resample, and
 * a resample with no task left is discarded.
 *
 * The range is the 2.5th and 97.5th percentiles of the estimates (percentile method, linear
 * interpolation between closest ranks: Hyndman and Fan type 7, the default of R and NumPy),
 * widened if needed to contain the difference itself, so no difference is ever printed outside
 * its own range. The widening only happens with very skewed or tiny samples and only makes the
 * verdict more cautious. All draws come from `random`, so the same seed gives the same range.
 */
function resampleRange(input: ResampleInput): [number, number] {
  const { metric, tasks, difference, random, resamples } = input;
  const reference = METRICS[metric].reference;
  const draw = (values: readonly number[]): number[] =>
    values.map(() => at(values, random.int(0, values.length)));

  const estimates: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const drawnTasks =
      tasks.length > 1 ? tasks.map(() => at(tasks, random.int(0, tasks.length))) : tasks;
    const differences: number[] = [];
    for (const task of drawnTasks) {
      const c = reference ?? mean(draw(task.control));
      const t = mean(draw(task.treatment));
      const taskDiff = taskDifference(metric, c, t);
      if (taskDiff !== undefined) differences.push(taskDiff);
    }
    if (differences.length > 0) estimates.push(mean(differences));
  }
  if (estimates.length === 0) return [difference, difference];
  estimates.sort((a, b) => a - b);
  return [
    Math.min(percentile(estimates, 0.025), difference),
    Math.max(percentile(estimates, 0.975), difference),
  ];
}

/** Type 7 percentile of sorted, non-empty `values` at `p` in [0, 1]. */
function percentile(values: readonly number[], p: number): number {
  const h = (values.length - 1) * p;
  const below = Math.floor(h);
  const low = at(values, below);
  const high = at(values, Math.min(below + 1, values.length - 1));
  return low + (h - below) * (high - low);
}

/** `values[index]` for an index known to be in bounds. */
function at<T>(values: readonly T[], index: number): T {
  return values[index] as T;
}

/**
 * The verdict of a range (brief §10, ADR 0005), decided in this order:
 *
 * 1. The whole range strictly on the good side of zero is `helps`; strictly on the bad side is
 *    `harms`. The good side is above zero when `higherIsBetter`, below otherwise. A range that
 *    excludes zero gets `helps` or `harms` even if it also sits inside the margin: the margin
 *    never overrides a range that excludes zero.
 * 2. A range that touches or crosses zero and sits entirely inside `[−margin, +margin]` is
 *    `placebo`. Metrics without a margin (`null`) can never be `placebo`.
 * 3. Anything else is `no_evidence`.
 */
export function decideVerdict(
  range: readonly [number, number],
  higherIsBetter: boolean,
  margin: number | null,
): Verdict {
  const [low, high] = range;
  if (low > 0) return higherIsBetter ? 'helps' : 'harms';
  if (high < 0) return higherIsBetter ? 'harms' : 'helps';
  if (margin !== null && low >= -margin && high <= margin) return 'placebo';
  return 'no_evidence';
}

export interface RunsNeededInput {
  /** The point estimate, kept fixed in the extrapolation. */
  readonly difference: number;
  readonly range: readonly [number, number];
  readonly margin: number | null;
  /** Current runs per task per arm (a mean when tasks differ). */
  readonly runsPerTask: number;
}

/**
 * Estimated runs per task per arm for a `no_evidence` row to reach another verdict, or
 * `undefined` when the estimate is above {@link RUNS_NEEDED_CAP} or can never be reached.
 *
 * Assumes the range's half-width `h = (high − low) / 2` shrinks as `1/√n` with `n` runs per task
 * per arm, so at `n` runs it is `h · √(n₀ / n)` where `n₀` is the current runs per task, and
 * keeps the range centred on the current difference `d`. The answer is the smallest `n` that
 * reaches either verdict, whichever comes first:
 *
 * - excluding zero (`helps`/`harms`): `h · √(n₀/n) < |d|`, so `n = ⌊n₀ · (h / |d|)²⌋ + 1`
 *   (impossible when `d = 0`);
 * - fitting inside the margin (`placebo`): `|d| + h · √(n₀/n) ≤ m`, so
 *   `n = ⌈n₀ · (h / (m − |d|))²⌉` (impossible without a margin or when `|d| ≥ m`);
 *
 * and never less than `⌊n₀⌋ + 1`, since the current runs did not decide.
 *
 * This is an estimate and can be wrong both ways: the difference itself moves as runs are added
 * (it may drift toward zero or away from it), the `1/√n` law ignores the spread between tasks,
 * which more runs per task do not shrink, and a range from few runs is itself noisy.
 */
export function estimateRunsNeeded(input: RunsNeededInput): number | undefined {
  const { difference, range, margin, runsPerTask } = input;
  const halfWidth = (range[1] - range[0]) / 2;
  const size = Math.abs(difference);
  if (halfWidth <= 0 || runsPerTask <= 0) return undefined;

  const candidates: number[] = [];
  if (size > 0) {
    candidates.push(Math.floor(runsPerTask * (halfWidth / size) ** 2) + 1);
  }
  if (margin !== null && size < margin) {
    candidates.push(Math.ceil(runsPerTask * (halfWidth / (margin - size)) ** 2));
  }
  if (candidates.length === 0) return undefined;
  const needed = Math.max(Math.min(...candidates), Math.floor(runsPerTask) + 1);
  return needed > RUNS_NEEDED_CAP ? undefined : needed;
}
