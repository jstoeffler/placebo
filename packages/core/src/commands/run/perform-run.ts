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
import { backoffMs } from './retry.js';

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
  /** The signal fired; `run` is the in-flight run, saved ungraded, if the agent had started. */
  | { readonly type: 'aborted'; readonly run?: Run }
  | {
      readonly type: 'infra_exhausted';
      readonly error: RunnerInfraError;
      readonly attempts: number;
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
 *    grading retries the grading alone, with the same backoff.
 *
 * The agent failing is never an error here: it is a run with its outcome. When `signal` fires,
 * no new attempt starts; a run whose agent had started is saved ungraded with the outcome the
 * runner gave it (`failed` when it was cut short).
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
      if (attempt + 1 >= ctx.maxInfraAttempts) {
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
  const change = await executorStep('the change could not be computed', () =>
    ctx.executor.computeChange(folder),
  );
  const stopped = aborted(ctx);
  let grades: Grade[] = [];
  let retries = agent.retries;
  if (!stopped) {
    ctx.reporter.report({ type: 'grading_started', runId: slot.runId });
    const graded = await gradeWithRetries(ctx, agent, change);
    if (graded.type === 'infra_exhausted') {
      await removeFolder(ctx, folder);
      return graded;
    }
    grades = graded.grades;
    retries += graded.retries;
  }

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
    grades,
    ...(kept ? { runFolder: folder.path } : {}),
    infraRetries: retries,
  };
  await ctx.store.save(run);
  ctx.reporter.report({ type: 'run_finished', runId: run.id, outcome });
  if (!kept) await removeFolder(ctx, folder);
  return stopped ? { type: 'aborted', run } : { type: 'finished', run };
}

type Graded =
  | { readonly type: 'graded'; readonly grades: Grade[]; readonly retries: number }
  | {
      readonly type: 'infra_exhausted';
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
      if (!(error instanceof RunnerInfraError)) throw error;
      if (attempt + 1 >= ctx.maxInfraAttempts) {
        return { type: 'infra_exhausted', error, attempts: attempt + 1 };
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
