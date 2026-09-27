import type { ArmName } from '../domain/arm.js';
import type { Outcome } from '../domain/events.js';
import type { ExperimentId, RunId, TaskId, VariantName } from '../kernel/ids.js';
import type { RunnerInfraReason } from './runner.js';

/**
 * Progress of a command, as data. The cli decides how it looks.
 *
 * A `run` command emits, in order: a `message` per up-front warning, `snapshot_ready`,
 * `experiment_started`, then per run `run_started`, any `run_retried`, `grading_started` and
 * `run_finished` (runs interleave when parallel), then `comparisons_started` per task and
 * treatment with a comparison grader, then `experiment_finished`.
 */
export type ProgressEvent =
  | {
      readonly type: 'experiment_started';
      readonly experimentId: ExperimentId;
      readonly totalRuns: number;
    }
  | {
      readonly type: 'run_started';
      readonly runId: RunId;
      readonly taskId: TaskId;
      readonly arm: ArmName;
    }
  | { readonly type: 'run_finished'; readonly runId: RunId; readonly outcome: Outcome }
  | {
      readonly type: 'run_retried';
      readonly runId: RunId;
      /** The attempt that failed, from 1. */
      readonly attempt: number;
      readonly reason: RunnerInfraReason;
      /** How long the command waits before the next attempt. */
      readonly delayMs: number;
    }
  | { readonly type: 'message'; readonly level: 'info' | 'warn'; readonly text: string }
  | {
      readonly type: 'snapshot_ready';
      readonly snapshotId: string;
      /**
       * Whether the snapshot came from the executor's cache. Absent: the `Executor` port does not
       * report it yet.
       */
      readonly cached?: boolean;
    }
  /** The agent finished; graders (hidden files, commands, judges) start on this run. */
  | { readonly type: 'grading_started'; readonly runId: RunId }
  | {
      readonly type: 'comparisons_started';
      readonly taskId: TaskId;
      readonly treatment: VariantName;
      /** Judge comparisons to make: treatment runs times comparison graders. */
      readonly pairs: number;
    }
  | {
      readonly type: 'experiment_finished';
      readonly experimentId: ExperimentId;
      readonly completedRuns: number;
      readonly totalRuns: number;
      readonly durationMs: number;
    };

/**
 * Where commands send progress. Commands never write to stdout or stderr themselves; the cli
 * renders these events, tests collect them.
 */
export interface Reporter {
  report(event: ProgressEvent): void;
}
