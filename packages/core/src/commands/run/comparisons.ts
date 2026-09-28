import { armName } from '../../domain/arm.js';
import type { Experiment } from '../../domain/experiment.js';
import type { Grade } from '../../domain/grade.js';
import type { Run } from '../../domain/run.js';
import type { Task } from '../../domain/suite.js';
import { type ComparisonGrade, gradeComparisons } from '../../graders/comparison.js';
import { ComparisonInfraError } from '../../graders/grading-infra-error.js';
import type { RunId, VariantName } from '../../kernel/ids.js';
import { createSeededRandom, MAX_SEED } from '../../kernel/random.js';
import type { Executor } from '../../ports/executor.js';
import type { Reporter } from '../../ports/reporter.js';
import type { RunStore } from '../../ports/run-store.js';
import type { RunnerInfraError, Runner } from '../../ports/runner.js';
import type { Sleep } from './perform-run.js';
import { backoffMs, isLastAttempt } from './retry.js';

export interface ComparisonContext {
  readonly experiment: Experiment;
  /** The experiment's tasks, in experiment order. */
  readonly tasks: readonly Task[];
  readonly executor: Pick<Executor, 'createJudgeFolder' | 'remove'>;
  readonly runner: Runner;
  readonly judgeModel: string;
  readonly store: RunStore;
  readonly reporter: Reporter;
  readonly sleep: Sleep;
  readonly maxInfraAttempts: number;
  /** Seeds every pairing and `a`/`b` position; the same seed gives the same comparisons. */
  readonly seed: number;
  readonly signal?: AbortSignal;
}

export type ComparisonsEnd =
  /** Every run, with comparison grades appended to the treatment runs, in the input order. */
  | { readonly type: 'done'; readonly runs: Run[] }
  | { readonly type: 'aborted'; readonly runs: Run[] }
  | {
      readonly type: 'infra_exhausted';
      readonly runs: Run[];
      readonly error: RunnerInfraError;
      readonly attempts: number;
    };

/**
 * Runs the comparison graders once every run exists: for each treatment in experiment order and
 * each task with a `comparison` grader, `gradeComparisons` pairs every treatment run with a
 * random control run of the task; the grades are appended to the treatment runs, which are saved
 * again. Each task and treatment draws from its own random stream, re-created on a retry, so an
 * infrastructure error retried with backoff replays the same pairings. When a task and treatment
 * give up, their grades so far and an error grade for every pairing that could not run are saved
 * before the comparisons end `infra_exhausted`.
 */
export async function runComparisons(
  ctx: ComparisonContext,
  runs: readonly Run[],
): Promise<ComparisonsEnd> {
  const current = [...runs];
  const seeds = createSeededRandom(ctx.seed);
  for (const arm of ctx.experiment.arms) {
    if (arm.kind === 'control') continue;
    for (const task of ctx.tasks) {
      const seed = seeds.int(0, MAX_SEED);
      const graders = task.graders.filter((grader) => grader.type === 'comparison').length;
      if (graders === 0) continue;
      if (ctx.signal?.aborted === true) return { type: 'aborted', runs: current };
      const treatmentRuns = current.filter(
        (run) => run.taskId === task.id && armName(run.arm) === arm.variant,
      );
      ctx.reporter.report({
        type: 'comparisons_started',
        taskId: task.id,
        treatment: arm.variant,
        pairs: treatmentRuns.length * graders,
      });

      const compared = await compareWithRetries(ctx, current, task, arm.variant, seed);
      await appendGrades(ctx, current, compared.grades);
      if (compared.type === 'infra_exhausted') {
        return {
          type: 'infra_exhausted',
          runs: current,
          error: compared.error,
          attempts: compared.attempts,
        };
      }
    }
  }
  return { type: 'done', runs: current };
}

/** Appends each grade to its run in `current`, saving every run that changed. */
async function appendGrades(
  ctx: Pick<ComparisonContext, 'store'>,
  current: Run[],
  graded: readonly ComparisonGrade[],
): Promise<void> {
  const added = new Map<RunId, Grade[]>();
  for (const { runId, grade } of graded) {
    added.set(runId, [...(added.get(runId) ?? []), grade]);
  }
  for (const [index, run] of current.entries()) {
    const grades = added.get(run.id);
    if (grades === undefined) continue;
    const updated: Run = { ...run, grades: [...run.grades, ...grades] };
    await ctx.store.save(updated);
    current[index] = updated;
  }
}

type Compared =
  | { readonly type: 'graded'; readonly grades: ComparisonGrade[] }
  /** Gave up; `grades` hold an error grade for every pairing that could not run. */
  | {
      readonly type: 'infra_exhausted';
      readonly grades: ComparisonGrade[];
      readonly error: RunnerInfraError;
      readonly attempts: number;
    };

async function compareWithRetries(
  ctx: ComparisonContext,
  runs: readonly Run[],
  task: Task,
  treatment: VariantName,
  seed: number,
): Promise<Compared> {
  const jitter = createSeededRandom(seed);
  for (let attempt = 0; ; attempt++) {
    try {
      const grades = await gradeComparisons({
        runner: ctx.runner,
        judgeModel: ctx.judgeModel,
        executor: ctx.executor,
        runs,
        task,
        treatment,
        random: createSeededRandom(seed),
      });
      return { type: 'graded', grades };
    } catch (error) {
      // Comparisons report infrastructure errors with the grades to save when giving up.
      if (!(error instanceof ComparisonInfraError)) throw error;
      if (isLastAttempt(error, attempt, ctx.maxInfraAttempts)) {
        return { type: 'infra_exhausted', grades: error.grades, error, attempts: attempt + 1 };
      }
      const delayMs = backoffMs(attempt, error.retryAfterMs, jitter);
      ctx.reporter.report({
        type: 'message',
        level: 'warn',
        text: `comparisons of task "${task.id}" for "${treatment}" hit an infrastructure error (${error.reason}); retrying in ${String(Math.round(delayMs / 1000))} s`,
      });
      await ctx.sleep(delayMs, ctx.signal);
    }
  }
}
