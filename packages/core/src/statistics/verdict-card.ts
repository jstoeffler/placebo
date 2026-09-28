import { armName, type ArmName } from '../domain/arm.js';
import type { Experiment } from '../domain/experiment.js';
import { METRICS, Metric, type MetricRow } from '../domain/metrics.js';
import type { Results, TaskArmBreakdown } from '../domain/results.js';
import type { Run } from '../domain/run.js';
import type { Margins } from '../domain/suite.js';
import { FEW_RUNS_THRESHOLD, FEW_TASKS_THRESHOLD, type Warning } from '../domain/warnings.js';
import type { TaskId } from '../kernel/ids.js';
import type { Random } from '../kernel/random.js';
import { computeMetricRow, type TaskSamples } from './metric-row.js';
import { isDeterministic, mean, metricValue } from './values.js';

export interface VerdictCardInput {
  /** Every run of the experiment, any arm; runs of other arms or tasks are ignored. */
  readonly runs: readonly Run[];
  readonly experiment: Experiment;
  /** The treatment compared with control; never `control` itself. */
  readonly treatment: ArmName;
  readonly margins: Margins;
  readonly random: Random;
  /** Resamples per range; defaults to `DEFAULT_RESAMPLES`. */
  readonly resamples?: number;
}

export interface VerdictCardSummary {
  /** One row per metric that has values, in `METRICS` order. */
  readonly rows: MetricRow[];
  /** Dead tasks of the whole experiment, excluded from every row. */
  readonly deadTasks: TaskId[];
  readonly warnings: Warning[];
  /** Control and this treatment, task by task, in experiment order. */
  readonly perTask: TaskArmBreakdown[];
}

/**
 * The verdict card of one treatment against control: dead tasks are found across every arm of
 * the experiment and left out, then each metric gets a row from `computeMetricRow`. Metrics with
 * no value on any remaining task (no checklist grader, no comparison grader, no deterministic
 * grader) get no row. Rows draw from `random` in `METRICS` order, so the same seed gives the
 * same card.
 */
export function buildVerdictCard(input: VerdictCardInput): VerdictCardSummary {
  const { experiment, treatment } = input;
  if (treatment === 'control') {
    throw new RangeError('buildVerdictCard compares a treatment with control; got "control"');
  }
  const index = indexRuns(input.runs, experiment);
  const deadTasks = findDeadTasks(index, experiment);
  const dead = new Set(deadTasks);
  const liveTasks = experiment.taskIds.filter((taskId) => !dead.has(taskId));

  const rows: MetricRow[] = [];
  for (const metric of Metric.options) {
    const reference = METRICS[metric].reference;
    const tasks: TaskSamples[] = liveTasks.map((taskId) => ({
      taskId,
      control: index.values(taskId, 'control', metric),
      treatment: index.values(taskId, treatment, metric),
    }));
    const hasValues = tasks.some(
      (task) => task.treatment.length > 0 && (reference !== undefined || task.control.length > 0),
    );
    if (!hasValues) continue;
    rows.push(
      computeMetricRow({
        metric,
        tasks,
        margins: input.margins,
        random: input.random,
        ...(input.resamples === undefined ? {} : { resamples: input.resamples }),
      }),
    );
  }

  return {
    rows,
    deadTasks,
    warnings: experimentWarnings(experiment, deadTasks),
    perTask: breakdown(index, experiment.taskIds, ['control', treatment]),
  };
}

export interface ExperimentSummaryInput {
  readonly runs: readonly Run[];
  readonly experiment: Experiment;
  readonly margins: Margins;
  readonly random: Random;
  readonly resamples?: number;
}

/** Everything `Results` holds that statistics compute; the run command adds the rest. */
export type ExperimentSummary = Pick<
  Results,
  'verdictCards' | 'breakdown' | 'deadTasks' | 'warnings'
>;

/**
 * {@link buildVerdictCard} for every treatment in suite order, sharing one `random` so the
 * whole summary replays from the experiment seed. `breakdown` covers every arm; `warnings` and
 * `deadTasks` are the experiment's, computed once.
 */
export function summarizeExperiment(input: ExperimentSummaryInput): ExperimentSummary {
  const { experiment } = input;
  const verdictCards: Results['verdictCards'] = [];
  for (const arm of experiment.arms) {
    if (arm.kind === 'control') continue;
    const card = buildVerdictCard({ ...input, treatment: arm.variant });
    verdictCards.push({ variant: arm.variant, rows: card.rows });
  }
  const index = indexRuns(input.runs, experiment);
  const deadTasks = findDeadTasks(index, experiment);
  return {
    verdictCards,
    breakdown: breakdown(index, experiment.taskIds, experiment.arms.map(armName)),
    deadTasks,
    warnings: experimentWarnings(experiment, deadTasks),
  };
}

/**
 * Warnings the statistics can detect (brief §9, §13): one `dead_task` per dead task,
 * `few_tasks` when fewer than `FEW_TASKS_THRESHOLD` tasks remain once dead tasks are left out,
 * `few_runs` when the experiment has fewer than `FEW_RUNS_THRESHOLD` runs per task, and
 * `judge_equals_subject` when the pinned judge model is the subject model.
 */
export function experimentWarnings(
  experiment: Experiment,
  deadTasks: readonly TaskId[],
): Warning[] {
  const warnings: Warning[] = deadTasks.map((taskId) => ({ type: 'dead_task', taskId }));
  const taskCount = experiment.taskIds.length - deadTasks.length;
  if (taskCount < FEW_TASKS_THRESHOLD) {
    warnings.push({ type: 'few_tasks', taskCount, threshold: FEW_TASKS_THRESHOLD });
  }
  if (experiment.runsPerTask < FEW_RUNS_THRESHOLD) {
    warnings.push({
      type: 'few_runs',
      runsPerTask: experiment.runsPerTask,
      threshold: FEW_RUNS_THRESHOLD,
    });
  }
  const { judgeModel, subjectModel } = experiment.pins;
  if (judgeModel === subjectModel) {
    warnings.push({ type: 'judge_equals_subject', model: judgeModel });
  }
  return warnings;
}

interface RunIndex {
  runs(taskId: TaskId, arm: ArmName): readonly Run[];
  values(taskId: TaskId, arm: ArmName, metric: Metric): number[];
}

/**
 * Groups runs by task and arm. A task "has deterministic graders" when any of its runs, in any
 * arm, carries a deterministic grade; its runs without one then count as failures for pass rate.
 */
function indexRuns(runs: readonly Run[], experiment: Experiment): RunIndex {
  const byKey = new Map<string, Run[]>();
  const deterministicTasks = new Set<TaskId>();
  const tasks = new Set(experiment.taskIds);
  const arms = new Set(experiment.arms.map(armName));
  const key = (taskId: TaskId, arm: ArmName): string => JSON.stringify([taskId, arm]);
  for (const run of runs) {
    const arm = armName(run.arm);
    if (!tasks.has(run.taskId) || !arms.has(arm)) continue;
    const k = key(run.taskId, arm);
    const list = byKey.get(k) ?? [];
    list.push(run);
    byKey.set(k, list);
    if (run.grades.some(isDeterministic)) deterministicTasks.add(run.taskId);
  }
  const runsOf = (taskId: TaskId, arm: ArmName): readonly Run[] =>
    byKey.get(key(taskId, arm)) ?? [];
  return {
    runs: runsOf,
    values(taskId, arm, metric) {
      const deterministicGraders = deterministicTasks.has(taskId);
      const values: number[] = [];
      for (const run of runsOf(taskId, arm)) {
        const value = metricValue(run, metric, { deterministicGraders });
        if (value !== undefined) values.push(value);
      }
      return values;
    },
  };
}

/**
 * Dead tasks (brief §9): tasks with a pass rate where every arm that has runs has a mean pass
 * rate of 0. Arms are all arms of the experiment, so a task is dead for every card or for none.
 */
function findDeadTasks(index: RunIndex, experiment: Experiment): TaskId[] {
  const arms = experiment.arms.map(armName);
  return experiment.taskIds.filter((taskId) => {
    const armValues = arms
      .map((arm) => index.values(taskId, arm, 'passRate'))
      .filter((values) => values.length > 0);
    return armValues.length > 0 && armValues.every((values) => mean(values) === 0);
  });
}

function breakdown(
  index: RunIndex,
  taskIds: readonly TaskId[],
  arms: readonly ArmName[],
): TaskArmBreakdown[] {
  return taskIds.flatMap((taskId) =>
    arms.map((arm) => {
      const means: TaskArmBreakdown['means'] = {};
      for (const metric of Metric.options) {
        const values = index.values(taskId, arm, metric);
        means[metric] = values.length === 0 ? null : mean(values);
      }
      return { taskId, arm, runCount: index.runs(taskId, arm).length, means };
    }),
  );
}
