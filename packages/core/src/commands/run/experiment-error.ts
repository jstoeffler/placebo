import type { ExperimentId, RunId } from '../../kernel/ids.js';
import type { RunnerInfraReason } from '../../ports/runner.js';

interface Progress {
  /** Absent when the experiment ended before it was saved. */
  readonly experimentId?: ExperimentId;
  /** Runs graded and saved before the experiment ended; they stay in the run store. */
  readonly completedRuns: number;
  readonly totalRuns: number;
  readonly message: string;
}

/**
 * Why an experiment ended early. The agent's own failures are never among these: they are runs
 * with outcome `failed` or `crashed`, counted against the pass rate.
 */
export type ExperimentError =
  /** An infrastructure error (spawn failure, rate limit, network) survived every attempt. */
  | (Progress & {
      readonly type: 'infra_exhausted';
      /** The run whose attempts ran out; absent when it was the Claude Code version lookup or a comparison. */
      readonly runId?: RunId;
      readonly reason: RunnerInfraReason;
      readonly attempts: number;
    })
  /** The executor could not prepare the snapshot or a run folder, compute a change or remove a folder. */
  | (Progress & { readonly type: 'executor_failed' })
  /** The abort signal fired; runs in flight ended as `failed` and no new run started. */
  | (Progress & { readonly type: 'aborted' })
  /** The task filter selects no task of the suite, or names a task the suite does not have. */
  | (Progress & { readonly type: 'no_tasks' })
  /** The variant filter selects no variant of the suite, or names one the suite does not have. */
  | (Progress & { readonly type: 'no_treatments' });

export type ExperimentErrorType = ExperimentError['type'];
