import { armName, type Arm } from '../../domain/arm.js';
import type { Change } from '../../domain/change.js';
import type { RunnerEvent } from '../../domain/events.js';
import type { Experiment } from '../../domain/experiment.js';
import type { Grade } from '../../domain/grade.js';
import { deriveMeasurements } from '../../domain/measure.js';
import type { RunKey, SuiteFiles } from '../../domain/run-key.js';
import type { Run } from '../../domain/run.js';
import type { Limits, Task } from '../../domain/suite.js';
import type { SuiteFileReader } from '../../graders/context.js';
import { gradeRun } from '../../graders/grade-run.js';
import { GradingInfraError } from '../../graders/grading-infra-error.js';
import type { Clock } from '../../kernel/clock.js';
import type { Sha256 } from '../../kernel/ids.js';
import { createSeededRandom, type Random } from '../../kernel/random.js';
import type { Executor, RunFolder, Snapshot } from '../../ports/executor.js';
import type { Reporter } from '../../ports/reporter.js';
import type { RunStore } from '../../ports/run-store.js';
import {
  DEFAULT_SETTING_SOURCES,
  RunnerInfraError,
  type RunRequest,
  type Runner,
  type RunnerResult,
} from '../../ports/runner.js';
import type { RunSlot } from './plan.js';
import { backoffMs, isLastAttempt } from './retry.js';

/** Which run folders stay on disk after grading (brief §11). */
export type KeepRunFolders = 'all' | 'reviewable' | 'none';

/** Waits `ms`, returning early if `signal` aborts; tests inject one that does not wait. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Everything one run needs that is the same for every run of the experiment. */
export interface RunContext {
  readonly experiment: Experiment;
  readonly snapshot: Snapshot;
  readonly subjectModel: string;
  readonly judgeModel: string;
  readonly sandbox: boolean;
  readonly limits: Limits;
  readonly tasks: ReadonlyMap<string, Task>;
  /** Task hash per task id. */
  readonly taskHashes: ReadonlyMap<string, Sha256>;
  /** Variant patch text and hash per patch path; the control arm hashes `''`. */
  readonly patches: ReadonlyMap<string, { readonly text: string; readonly hash: Sha256 }>;
  readonly controlHash: Sha256;
  readonly files: SuiteFiles;
  readonly executor: Executor;
  readonly runner: Runner;
  readonly store: RunStore;
  readonly reporter: Reporter;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly keepRunFolders: KeepRunFolders;
  readonly maxInfraAttempts: number;
  readonly signal?: AbortSignal;
}

/** How one run ended, from the experiment's point of view. */
export type RunEnd =
  | { readonly type: 'finished'; readonly run: Run }
  /** The signal fired; nothing of this run was saved and its run folder is gone. */
  | { readonly type: 'aborted' }
  | {
      readonly type: 'infra_exhausted';
      readonly error: RunnerInfraError;
      readonly attempts: number;
      /**
       * The run, saved with an error grade for each grader that could not run, when the agent
       * had completed and grading gave up; absent when the agent itself never finished.
       */
      readonly run?: Run;
    }
  | { readonly type: 'executor_failed'; readonly message: string };

/** An executor call failed; ends the experiment with `executor_failed`. */
class ExecutorStepError extends Error {
  override readonly name = 'ExecutorStepError';
}

async function executorStep<T>(what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new ExecutorStepError(
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Whether a run folder of `task` stays after grading: `all` keeps every one, `none` none, and
 * `reviewable` only those of tasks a person may want to open: tasks with review questions, a
 * checklist or a comparison grader.
 */
function keepsRunFolder(policy: KeepRunFolders, task: Task): boolean {
  if (policy === 'all') return true;
  if (policy === 'none') return false;
  return (
    task.review !== undefined ||
    task.graders.some((grader) => grader.type === 'checklist' || grader.type === 'comparison')
  );
}

/** The request for a subject run: the bare prompt, project settings only, every tool (brief §7). */
function subjectRequest(
  ctx: Pick<RunContext, 'subjectModel' | 'sandbox' | 'limits' | 'signal'>,
  task: Task,
  folder: RunFolder,
): RunRequest {
  return {
    cwd: folder.path,
    prompt: task.prompt,
    model: ctx.subjectModel,
    settingSources: DEFAULT_SETTING_SOURCES,
    sandbox: ctx.sandbox,
    strictMcpConfig: true,
    limits: ctx.limits,
    tools: 'all',
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
}

/**
 * Performs one run from a fresh run folder to a saved, graded `Run`:
 *
 * 1. Creates a run folder from the snapshot with the arm's variant patch and starts the agent.
 * 2. On `RunnerInfraError`, removes the folder, emits `run_retried`, waits the backoff (the
 *    server's `retryAfterMs`, otherwise `min(1000 × 2^attempt, 60000)`, plus jitter) and starts
 *    again from a fresh folder, up to `maxInfraAttempts` attempts in all.
 * 3. Once the agent finished: computes the change and the measurements, builds the run key,
 *    grades the run (hidden files enter the folder only now), saves it, emits `run_finished`,
 *    then removes the folder unless `keepRunFolders` keeps it. An infrastructure error while
 *    grading retries the grading alone, with the same backoff. When grading gives up (attempts
 *    ran out, or a reason no retry fixes), the run is still saved and `run_finished` emitted,
 *    with an error grade for each grader that could not run, and the run ends `infra_exhausted`
 *    with that run: a run whose agent completed is never discarded.
 *
 * The agent failing is never an error here: it is a run with its outcome. When `signal` fires,
 * no new attempt starts, and a run whose agent was in flight is not a run at all: it is never
 * saved, emits no `run_finished`, and its folder is removed whatever `keepRunFolders` says, since
 * it holds no reviewable result.
 */
export async function performRun(ctx: RunContext, slot: RunSlot): Promise<RunEnd> {
  const task = ctx.tasks.get(slot.taskId);
  if (task === undefined) throw new Error(`performRun: unknown task "${slot.taskId}"`);
  if (aborted(ctx)) return { type: 'aborted' };
  ctx.reporter.report({
    type: 'run_started',
    runId: slot.runId,
    taskId: slot.taskId,
    arm: armName(slot.arm),
  });
  const random = createSeededRandom(slot.seed);
  try {
    return await attemptRun(ctx, slot, task, random);
  } catch (error) {
    if (error instanceof ExecutorStepError)
      return { type: 'executor_failed', message: error.message };
    throw error;
  }
}

async function attemptRun(
  ctx: RunContext,
  slot: RunSlot,
  task: Task,
  random: Random,
): Promise<RunEnd> {
  const patch = patchOf(ctx, slot.arm);
  let retries = 0;
  for (let attempt = 0; ; attempt++) {
    if (aborted(ctx)) return { type: 'aborted' };
    const startedAt = ctx.clock.now().toISOString();
    const folder = await executorStep('the run folder could not be created', () =>
      ctx.executor.createRunFolder(ctx.snapshot, patch?.text),
    );
    const events: RunnerEvent[] = [];
    let result: RunnerResult;
    try {
      result = await ctx.runner.run(subjectRequest(ctx, task, folder), (event) => {
        events.push(event);
      });
    } catch (error) {
      await removeFolder(ctx, folder);
      if (aborted(ctx)) return { type: 'aborted' };
      if (!(error instanceof RunnerInfraError)) throw error;
      if (isLastAttempt(error, attempt, ctx.maxInfraAttempts)) {
        return { type: 'infra_exhausted', error, attempts: attempt + 1 };
      }
      retries += 1;
      const delayMs = backoffMs(attempt, error.retryAfterMs, random);
      ctx.reporter.report({
        type: 'run_retried',
        runId: slot.runId,
        attempt: attempt + 1,
        reason: error.reason,
        delayMs,
      });
      await ctx.sleep(delayMs, ctx.signal);
      continue;
    }
    return finishRun(ctx, { slot, task, folder, events, result, startedAt, retries, random });
  }
}

interface FinishedAgent {
  readonly slot: RunSlot;
  readonly task: Task;
  readonly folder: RunFolder;
  readonly events: readonly RunnerEvent[];
  readonly result: RunnerResult;
  readonly startedAt: string;
  readonly retries: number;
  readonly random: Random;
}

async function finishRun(ctx: RunContext, agent: FinishedAgent): Promise<RunEnd> {
  const { slot, task, folder, events } = agent;
  const outcome = agent.result.result.outcome;
  if (aborted(ctx)) {
    await removeFolder(ctx, folder);
    return { type: 'aborted' };
  }
  const change = await executorStep('the change could not be computed', () =>
    ctx.executor.computeChange(folder),
  );
  if (aborted(ctx)) {
    await removeFolder(ctx, folder);
    return { type: 'aborted' };
  }
  ctx.reporter.report({ type: 'grading_started', runId: slot.runId });
  const graded = await gradeWithRetries(ctx, agent, change);

  const kept = keepsRunFolder(ctx.keepRunFolders, task);
  const run: Run = {
    id: slot.runId,
    experimentId: ctx.experiment.id,
    key: runKeyOf(ctx, task, slot.arm),
    taskId: slot.taskId,
    arm: slot.arm,
    startedAt: agent.startedAt,
    finishedAt: ctx.clock.now().toISOString(),
    outcome,
    measurements: deriveMeasurements(events, change),
    events: [...events],
    change,
    grades: graded.grades,
    ...(kept ? { runFolder: folder.path } : {}),
    infraRetries: agent.retries + graded.retries,
  };
  await ctx.store.save(run);
  ctx.reporter.report({ type: 'run_finished', runId: run.id, outcome });
  if (!kept) await removeFolder(ctx, folder);
  return graded.type === 'graded'
    ? { type: 'finished', run }
    : { type: 'infra_exhausted', error: graded.error, attempts: graded.attempts, run };
}

type Graded =
  | { readonly type: 'graded'; readonly grades: Grade[]; readonly retries: number }
  /** Grading gave up; `grades` hold an error grade for every grader that could not run. */
  | {
      readonly type: 'infra_exhausted';
      readonly grades: Grade[];
      readonly retries: number;
      readonly error: RunnerInfraError;
      readonly attempts: number;
    };

async function gradeWithRetries(
  ctx: RunContext,
  agent: FinishedAgent,
  change: Change,
): Promise<Graded> {
  const suiteFiles: SuiteFileReader = (path) => {
    const content = ctx.files.get(path);
    return content === undefined
      ? Promise.reject(new Error(`suite file ${path} was not loaded`))
      : Promise.resolve(content);
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const grades = await gradeRun({
        task: agent.task,
        arm: agent.slot.arm,
        runFolder: agent.folder,
        executor: ctx.executor,
        runner: ctx.runner,
        judgeModel: ctx.judgeModel,
        change,
        events: agent.events,
        outcome: agent.result.result.outcome,
        suiteFiles,
        random: agent.random,
        clock: ctx.clock,
      });
      return { type: 'graded', grades, retries: attempt };
    } catch (error) {
      // Graders report infrastructure errors with the grades to save when giving up.
      if (!(error instanceof GradingInfraError)) throw error;
      if (isLastAttempt(error, attempt, ctx.maxInfraAttempts)) {
        return {
          type: 'infra_exhausted',
          grades: error.grades,
          retries: attempt,
          error,
          attempts: attempt + 1,
        };
      }
      const delayMs = backoffMs(attempt, error.retryAfterMs, agent.random);
      ctx.reporter.report({
        type: 'run_retried',
        runId: agent.slot.runId,
        attempt: attempt + 1,
        reason: error.reason,
        delayMs,
      });
      await ctx.sleep(delayMs, ctx.signal);
    }
  }
}

/** The run key (ADR 0006): pinned commit, subject model and Claude Code version. */
function runKeyOf(ctx: RunContext, task: Task, arm: Arm): RunKey {
  const taskHash = ctx.taskHashes.get(task.id);
  if (taskHash === undefined) throw new Error(`no task hash for "${task.id}"`);
  return {
    taskHash,
    variantHash: patchOf(ctx, arm)?.hash ?? ctx.controlHash,
    commitHash: ctx.snapshot.commit,
    subjectModel: ctx.subjectModel,
    claudeCodeVersion: ctx.experiment.pins.claudeCodeVersion,
  };
}

function patchOf(
  ctx: RunContext,
  arm: Arm,
): { readonly text: string; readonly hash: Sha256 } | undefined {
  if (arm.kind === 'control') return undefined;
  const patch = ctx.patches.get(arm.patch);
  if (patch === undefined) throw new Error(`variant patch ${arm.patch} was not loaded`);
  return patch;
}

function removeFolder(ctx: RunContext, folder: RunFolder): Promise<void> {
  return executorStep(`the run folder ${folder.path} could not be removed`, () =>
    ctx.executor.remove(folder),
  );
}

function aborted(ctx: Pick<RunContext, 'signal'>): boolean {
  return ctx.signal?.aborted === true;
}
