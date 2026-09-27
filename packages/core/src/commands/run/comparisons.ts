import { armName } from '../../domain/arm.js';
import type { Experiment } from '../../domain/experiment.js';
import type { Grade } from '../../domain/grade.js';
import type { Run } from '../../domain/run.js';
import type { Task } from '../../domain/suite.js';
import { gradeComparisons } from '../../graders/comparison.js';
import type { RunId, VariantName } from '../../kernel/ids.js';
import { createSeededRandom, MAX_SEED } from '../../kernel/random.js';
import type { Executor } from '../../ports/executor.js';
import type { Reporter } from '../../ports/reporter.js';
import type { RunStore } from '../../ports/run-store.js';
import { RunnerInfraError, type Runner } from '../../ports/runner.js';
import type { Sleep } from './perform-run.js';
import { backoffMs } from './retry.js';

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
 * infrastructure error retried with backoff replays the same pairings.
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
      if (compared.type === 'infra_exhausted') return { ...compared, runs: current };

      const added = new Map<RunId, Grade[]>();
      for (const { runId, grade } of compared.grades) {
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
  }
  return { type: 'done', runs: current };
}

type Compared =
  | { readonly type: 'graded'; readonly grades: Awaited<ReturnType<typeof gradeComparisons>> }
  | {
      readonly type: 'infra_exhausted';
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
      if (!(error instanceof RunnerInfraError)) throw error;
      if (attempt + 1 >= ctx.maxInfraAttempts) {
        return { type: 'infra_exhausted', error, attempts: attempt + 1 };
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
