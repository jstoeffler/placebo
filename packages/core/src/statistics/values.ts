import type { Grade } from '../domain/grade.js';
import type { Metric } from '../domain/metrics.js';
import type { Run } from '../domain/run.js';

export interface MetricValueOptions {
  /**
   * Whether the run's task declares deterministic graders. Defaults to "the run carries at
   * least one deterministic grade". Pass it when known (for example inferred from the other runs
   * of the task) so an ungraded crashed run still counts as a failure instead of vanishing.
   */
  readonly deterministicGraders?: boolean;
}

/**
 * The value of one metric for one run, or `undefined` when the metric does not apply to it.
 *
 * - `passRate`: 1 when the outcome is `completed` and every deterministic grade has
 *   `passed === true`; 0 otherwise (including a run of a task with deterministic graders that
 *   carries none, since nothing verified it). `undefined` when the task has no deterministic
 *   graders.
 * - `costUsd`, `tokensIn`, `tokensOut`, `cacheRead`, `cacheWrite`, `turns`, `durationMs`: read
 *   straight from `measurements`.
 * - `checklist`: mean score (count of yes) of the judge grades from `checklist` graders;
 *   `undefined` when there are none. Reviews are separate grades and do not count here.
 * - `winRate`: mean of {@link comparisonWin} over the judge grades from `comparison` graders on a
 *   treatment run, so 1 when this run was preferred and 0 when it was not; `undefined` on control
 *   runs and on runs without comparison grades.
 */
export function metricValue(
  run: Run,
  metric: Metric,
  options: MetricValueOptions = {},
): number | undefined {
  const { measurements } = run;
  switch (metric) {
    case 'passRate':
      return passRate(run, options.deterministicGraders);
    case 'costUsd':
      return measurements.costUsd;
    case 'tokensIn':
      return measurements.tokens.input;
    case 'tokensOut':
      return measurements.tokens.output;
    case 'cacheRead':
      return measurements.tokens.cacheRead;
    case 'cacheWrite':
      return measurements.tokens.cacheWrite;
    case 'turns':
      return measurements.turns;
    case 'durationMs':
      return measurements.durationMs;
    case 'checklist':
      return meanOrUndefined(judgeGrades(run, 'checklist').map((grade) => grade.score));
    case 'winRate':
      return run.arm.kind === 'control'
        ? undefined
        : meanOrUndefined(judgeGrades(run, 'comparison').map(comparisonWin));
  }
}

/** True for grades from deterministic graders (command, file and regex checks, tool used). */
export function isDeterministic(grade: Grade): boolean {
  return grade.kind === 'deterministic';
}

/**
 * 1 when the run holding this comparison grade was preferred over its opponent, 0 when not.
 * Comparison grades score 1 for a win and 0 for a loss (`domain/grade.ts`); a fractional score
 * from repeated judge calls is kept as the share of repeats won.
 */
export function comparisonWin(grade: Grade): number {
  return grade.score;
}

function passRate(run: Run, deterministicGraders: boolean | undefined): number | undefined {
  const deterministic = run.grades.filter(isDeterministic);
  if (!(deterministicGraders ?? deterministic.length > 0)) return undefined;
  const passed =
    run.outcome === 'completed' &&
    deterministic.length > 0 &&
    deterministic.every((grade) => grade.passed === true);
  return passed ? 1 : 0;
}

function judgeGrades(run: Run, type: 'checklist' | 'comparison'): Grade[] {
  return run.grades.filter((grade) => grade.kind === 'judge' && grade.grader.type === type);
}

function meanOrUndefined(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : mean(values);
}

/**
 * Arithmetic mean; `NaN` for an empty list, so callers check the length first. A list of one
 * repeated value has exactly that value as its mean: summing can drift by a rounding error
 * (three runs of 0.7 sum to 2.0999999999999996), which would turn two arms with the same value
 * but different run counts into a tiny nonzero difference.
 */
export function mean(values: readonly number[]): number {
  const [first] = values;
  if (values.every((value) => value === first)) return first ?? Number.NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
