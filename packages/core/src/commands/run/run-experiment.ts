import type { Arm } from '../../domain/arm.js';
import { Experiment } from '../../domain/experiment.js';
import type { Results } from '../../domain/results.js';
import { hashTask, hashVariant, type SuiteFiles } from '../../domain/run-key.js';
import type { Run } from '../../domain/run.js';
import type { Suite } from '../../domain/suite.js';
import type { Clock } from '../../kernel/clock.js';
import { ExperimentId, type Sha256, type TaskId, type VariantName } from '../../kernel/ids.js';
import { createSeededRandom, MAX_SEED } from '../../kernel/random.js';
import { err, ok, type Result } from '../../kernel/result.js';
import type { Executor, Snapshot } from '../../ports/executor.js';
import type { Reporter } from '../../ports/reporter.js';
import type { RunStore } from '../../ports/run-store.js';
import { RunnerInfraError, type Runner } from '../../ports/runner.js';
import { assembleResults } from './assemble-results.js';
import { runComparisons } from './comparisons.js';
import type { ExperimentError } from './experiment-error.js';
import {
  performRun,
  type KeepRunFolders,
  type RunContext,
  type RunEnd,
  type Sleep,
} from './perform-run.js';
import { planRuns, runPool } from './plan.js';
import { DEFAULT_MAX_INFRA_ATTEMPTS, sleep as realSleep } from './retry.js';
import { selectArms, selectTasks } from './select.js';
import { describeWarning, upfrontWarnings } from './warnings.js';

export interface RunExperimentOptions {
  /** Runs per task per arm; the suite's `runs` when absent. */
  readonly runs?: number;
  /** Runs in flight at once; the suite's `parallelism` when absent. */
  readonly parallelism?: number;
  /** Only these tasks, in suite order; every task when absent. */
  readonly tasks?: readonly TaskId[];
  /** Only these treatments, in suite order; every variant when absent. Control always runs. */
  readonly variants?: readonly VariantName[];
  /** Which run folders stay after grading; `all` by default (brief §11). */
  readonly keepRunFolders?: KeepRunFolders;
  /** Stops the experiment: runs in flight end as `failed`, no new run starts. */
  readonly signal?: AbortSignal;
  /** Attempts per run before an infrastructure error ends the experiment; 5 by default. */
  readonly maxInfraAttempts?: number;
}

export interface RunExperimentInput {
  readonly suite: Suite;
  /** Every file the suite references, as `loadSuite` returns them. */
  readonly files: SuiteFiles;
  readonly suiteHash: Sha256;
  readonly executor: Executor;
  readonly runner: Runner;
  readonly store: RunStore;
  readonly reporter: Reporter;
  readonly clock: Clock;
  /**
   * The experiment's random source, recorded in the experiment. Run order, retry jitter,
   * comparison pairings and resampling all draw from streams derived from it.
   */
  readonly seed: number;
  readonly placeboVersion: string;
  readonly options?: RunExperimentOptions;
  /** Waits between retries; tests inject one that returns at once. */
  readonly sleep?: Sleep;
  /** Resamples per range; statistics' default when absent. */
  readonly resamples?: number;
}

export interface RunExperimentOutput {
  readonly experiment: Experiment;
  readonly results: Results;
}

/**
 * Runs an experiment (brief §6 to §10):
 *
 * 1. Selects tasks and arms, and emits the warnings known before anything is spent.
 * 2. Pins the Claude Code version and the snapshot (the pinned commit resolved to its full id),
 *    then saves the `Experiment` before any run.
 * 3. Plans every task × arm × run index, shuffled by the seed so arms interleave, and performs
 *    them with `parallelism` runs in flight (see `performRun`).
 * 4. Runs the comparison graders once every run exists, appending their grades to the treatment
 *    runs.
 * 5. Assembles and validates the results.
 *
 * Ends early with an `ExperimentError` when infrastructure errors outlast the retries, the
 * executor fails, or `options.signal` aborts; runs saved until then stay in the store. The
 * agent's own failures are runs, never errors. Only bugs throw.
 */
export async function runExperiment(
  input: RunExperimentInput,
): Promise<Result<RunExperimentOutput, ExperimentError>> {
  const { suite, clock, reporter, options = {} } = input;
  const started = clock.now();
  const runsPerTask = options.runs ?? suite.runs;
  const signal = options.signal;
  // A function, not the property: flow analysis would pin `aborted` to its first reading.
  const isAborted = (): boolean => signal?.aborted === true;

  const tasks = selectTasks(suite, options.tasks);
  if (!tasks.ok) {
    return err({ type: 'no_tasks', completedRuns: 0, totalRuns: 0, message: tasks.error });
  }
  const arms = selectArms(suite, options.variants);
  if (!arms.ok) {
    return err({ type: 'no_treatments', completedRuns: 0, totalRuns: 0, message: arms.error });
  }
  const totalRuns = tasks.value.length * arms.value.length * runsPerTask;
  const before = { completedRuns: 0, totalRuns };

  const patches = decodePatches(arms.value, input.files);
  const warnings = upfrontWarnings({
    suite,
    arms: arms.value,
    taskCount: tasks.value.length,
    patchText: (patch) => patches.get(patch)?.text ?? '',
  });
  for (const warning of warnings) {
    reporter.report({ type: 'message', level: 'warn', text: describeWarning(warning) });
  }

  if (isAborted()) return err(aborted(before, 0));
  const pinned = await pin(input);
  if (!pinned.ok) return err({ ...pinned.error, ...before });
  const { snapshot, claudeCodeVersion } = pinned.value;
  reporter.report({ type: 'snapshot_ready', snapshotId: snapshot.id });

  const experiment = Experiment.parse({
    id: experimentIdOf(started, input.seed),
    createdAt: started.toISOString(),
    pins: {
      commit: snapshot.commit,
      subjectModel: suite.model,
      judgeModel: suite.judgeModel,
      claudeCodeVersion,
      suiteHash: input.suiteHash,
      placeboVersion: input.placeboVersion,
    },
    runsPerTask,
    taskIds: tasks.value.map((task) => task.id),
    arms: arms.value,
    seed: input.seed,
  });
  await input.store.saveExperiment(experiment);
  reporter.report({ type: 'experiment_started', experimentId: experiment.id, totalRuns });

  const random = createSeededRandom(input.seed);
  const slots = planRuns({
    experimentId: experiment.id,
    taskIds: experiment.taskIds,
    arms: experiment.arms,
    runsPerTask,
    random,
  });
  const sleep = input.sleep ?? realSleep;
  const maxInfraAttempts = options.maxInfraAttempts ?? DEFAULT_MAX_INFRA_ATTEMPTS;
  const ctx: RunContext = {
    experiment,
    snapshot,
    subjectModel: suite.model,
    judgeModel: suite.judgeModel,
    sandbox: suite.sandbox,
    limits: suite.limits ?? {},
    tasks: new Map(tasks.value.map((task) => [task.id, task])),
    taskHashes: new Map(tasks.value.map((task) => [task.id, hashTask(task, input.files)])),
    patches,
    controlHash: hashVariant(null),
    files: input.files,
    executor: input.executor,
    runner: input.runner,
    store: input.store,
    reporter,
    clock,
    sleep,
    keepRunFolders: options.keepRunFolders ?? 'all',
    maxInfraAttempts,
    ...(signal === undefined ? {} : { signal }),
  };

  const finished: Run[] = [];
  // An object, not `let`s: the pool's callback sets it, which flow analysis cannot see.
  const stop: { end?: Exclude<RunEnd, { type: 'finished' }>; runId?: Run['id'] } = {};
  await runPool(
    slots,
    options.parallelism ?? suite.parallelism,
    async (slot) => {
      const end = await performRun(ctx, slot);
      if (end.type === 'finished') {
        finished.push(end.run);
        return 'continue';
      }
      // The first infrastructure or executor failure explains the stop better than an abort.
      if (stop.end === undefined || stop.end.type === 'aborted') {
        stop.end = end;
        stop.runId = slot.runId;
      }
      return 'stop';
    },
    isAborted,
  );

  const finish = (completedRuns: number): void => {
    reporter.report({
      type: 'experiment_finished',
      experimentId: experiment.id,
      completedRuns,
      totalRuns,
      durationMs: clock.now().getTime() - started.getTime(),
    });
  };
  const progress = { experimentId: experiment.id, totalRuns };
  const failWith = (error: ExperimentError): Result<never, ExperimentError> => {
    finish(error.completedRuns);
    return err(error);
  };

  const stopped = stop.end;
  if (stopped !== undefined && stopped.type !== 'aborted') {
    const completedRuns = finished.length;
    return failWith(
      stopped.type === 'executor_failed'
        ? { type: 'executor_failed', ...progress, completedRuns, message: stopped.message }
        : {
            type: 'infra_exhausted',
            ...progress,
            completedRuns,
            ...(stop.runId === undefined ? {} : { runId: stop.runId }),
            reason: stopped.error.reason,
            attempts: stopped.attempts,
            message: stopped.error.message,
          },
    );
  }
  if (stopped !== undefined || isAborted()) {
    return failWith(aborted(progress, finished.length));
  }

  const ordered = orderLike(finished, slots);
  const compared = await runComparisons(
    {
      experiment,
      tasks: tasks.value,
      executor: input.executor,
      runner: input.runner,
      judgeModel: suite.judgeModel,
      store: input.store,
      reporter,
      sleep,
      maxInfraAttempts,
      seed: random.int(0, MAX_SEED),
      ...(signal === undefined ? {} : { signal }),
    },
    ordered,
  );
  if (compared.type === 'infra_exhausted') {
    return failWith({
      type: 'infra_exhausted',
      ...progress,
      completedRuns: finished.length,
      reason: compared.error.reason,
      attempts: compared.attempts,
      message: compared.error.message,
    });
  }
  if (compared.type === 'aborted') return failWith(aborted(progress, finished.length));

  const results = assembleResults({
    experiment,
    runs: compared.runs,
    reviews: [],
    suite,
    margins: suite.margins,
    random: createSeededRandom(input.seed),
    clock,
    warnings,
    ...(input.resamples === undefined ? {} : { resamples: input.resamples }),
  });
  finish(finished.length);
  return ok({ experiment, results });
}

type PinError = Pick<ExperimentError, 'message'> &
  (
    | { readonly type: 'executor_failed' }
    | {
        readonly type: 'infra_exhausted';
        readonly reason: RunnerInfraError['reason'];
        readonly attempts: number;
      }
  );

/** The Claude Code version from the runner and the snapshot from the executor. */
async function pin(
  input: RunExperimentInput,
): Promise<Result<{ snapshot: Snapshot; claudeCodeVersion: string }, PinError>> {
  let claudeCodeVersion: string;
  try {
    claudeCodeVersion = await input.runner.claudeCodeVersion();
  } catch (error) {
    if (!(error instanceof RunnerInfraError)) throw error;
    return err({
      type: 'infra_exhausted',
      reason: error.reason,
      attempts: 1,
      message: `the Claude Code version could not be read: ${error.message}`,
    });
  }
  try {
    const snapshot = await input.executor.prepareSnapshot({
      repo: input.suite.repo,
      commit: input.suite.commit,
      ...(input.suite.setup === undefined ? {} : { setup: input.suite.setup }),
    });
    return ok({ snapshot, claudeCodeVersion });
  } catch (error) {
    return err({
      type: 'executor_failed',
      message: `the snapshot could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function aborted(
  progress: { readonly experimentId?: ExperimentId; readonly totalRuns: number },
  completedRuns: number,
): ExperimentError {
  return {
    type: 'aborted',
    ...progress,
    completedRuns,
    message: `aborted after ${String(completedRuns)} of ${String(progress.totalRuns)} runs`,
  };
}

/** Patch text (UTF-8) and variant hash (of the bytes) per treatment's patch path. */
function decodePatches(
  arms: readonly Arm[],
  files: SuiteFiles,
): Map<string, { readonly text: string; readonly hash: Sha256 }> {
  const patches = new Map<string, { readonly text: string; readonly hash: Sha256 }>();
  for (const arm of arms) {
    if (arm.kind === 'control') continue;
    const content = files.get(arm.patch);
    if (content === undefined) throw new Error(`variant patch ${arm.patch} was not loaded`);
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    patches.set(arm.patch, { text, hash: hashVariant(content) });
  }
  return patches;
}

/** `20260927-100000-0000002a`: when it started (UTC) and its seed, readable in a terminal. */
function experimentIdOf(started: Date, seed: number): ExperimentId {
  const stamp = started
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
  return ExperimentId.parse(`${stamp}-${seed.toString(16).padStart(8, '0')}`);
}

/** Runs in the planned order, so comparisons do not depend on which run finished first. */
function orderLike(runs: readonly Run[], slots: readonly { readonly runId: string }[]): Run[] {
  const position = new Map(slots.map((slot, index) => [slot.runId, index]));
  return [...runs].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}
