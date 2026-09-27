import {
  METRICS,
  type Arm,
  type ArmName,
  type Grade,
  type Metric,
  type MetricRow,
  type Outcome,
  type Results,
  type Review,
  type Run,
  type TaskSummary,
} from '@placebo-eval/core/results';

/** Metrics in card order: pass rate and cost first, then the rest (brief §10). */
export const METRIC_ORDER = Object.keys(METRICS) as Metric[];

export function armName(arm: Arm): ArmName {
  return arm.kind === 'control' ? 'control' : arm.variant;
}

/** Card rows in card order; metrics absent from the data are simply not there. */
export function orderedRows(rows: readonly MetricRow[]): MetricRow[] {
  return [...rows].sort((a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric));
}

export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  completed: 'completed',
  failed: 'failed',
  crashed: 'crashed',
  stopped_by_permission_denial: 'stopped by permission denial',
};

export const OUTCOMES = Object.keys(OUTCOME_LABEL) as Outcome[];

/** Lookups derived once from `Results`. */
export interface Index {
  readonly results: Results;
  readonly armNames: readonly ArmName[];
  readonly runsById: ReadonlyMap<string, Run>;
  readonly tasksById: ReadonlyMap<string, TaskSummary>;
  readonly dead: ReadonlySet<string>;
  readonly reviewsByRun: ReadonlyMap<string, readonly Review[]>;
}

export function buildIndex(results: Results): Index {
  const reviewsByRun = new Map<string, Review[]>();
  for (const review of results.reviews) {
    const list = reviewsByRun.get(review.runId) ?? [];
    list.push(review);
    reviewsByRun.set(review.runId, list);
  }
  return {
    results,
    armNames: results.experiment.arms.map(armName),
    runsById: new Map(results.runs.map((run) => [run.id, run])),
    tasksById: new Map(results.tasks.map((task) => [task.id, task])),
    dead: new Set(results.deadTasks),
    reviewsByRun,
  };
}

export interface RunFilter {
  readonly task?: string;
  readonly arm?: string;
  readonly outcome?: string;
}

/** The filter with one key set, or cleared when `value` is empty. */
export function withFilter(filter: RunFilter, key: keyof RunFilter, value: string): RunFilter {
  return Object.fromEntries(
    Object.entries({ ...filter, [key]: value }).filter((entry) => entry[1] !== ''),
  );
}

export function filterRuns(runs: readonly Run[], filter: RunFilter): Run[] {
  return runs.filter(
    (run) =>
      (filter.task === undefined || run.taskId === filter.task) &&
      (filter.arm === undefined || armName(run.arm) === filter.arm) &&
      (filter.outcome === undefined || run.outcome === filter.outcome),
  );
}

/** Deterministic grades of a run: how many passed out of how many. */
export function deterministicTally(run: Run): { readonly passed: number; readonly total: number } {
  const deterministic = run.grades.filter((grade) => grade.kind === 'deterministic');
  return {
    passed: deterministic.filter((grade) => grade.passed === true).length,
    total: deterministic.length,
  };
}

/** The label of the grader behind a grade, from the task summary. */
export function graderLabel(grade: Grade, task: TaskSummary | undefined): string {
  if (grade.grader.type === 'review') return 'review';
  const index = grade.grader.index;
  return task?.graders.find((grader) => grader.index === index)?.label ?? grade.grader.type;
}

/** Short, stable label for a run in lists: its task, arm and position among its siblings. */
export function runOrdinal(run: Run, runs: readonly Run[]): number {
  const siblings = runs.filter(
    (other) => other.taskId === run.taskId && armName(other.arm) === armName(run.arm),
  );
  return siblings.indexOf(run) + 1;
}
