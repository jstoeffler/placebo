import type { ArmName } from '../domain/arm.js';
import type { Outcome } from '../domain/events.js';
import type { ExperimentId, RunId, TaskId } from '../kernel/ids.js';
import type { RunnerInfraReason } from './runner.js';

/** Progress of a command, as data. The cli decides how it looks. */
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
      readonly attempt: number;
      readonly reason: RunnerInfraReason;
    }
  | { readonly type: 'message'; readonly level: 'info' | 'warn'; readonly text: string };

/**
 * Where commands send progress. Commands never write to stdout or stderr themselves; the cli
 * renders these events, tests collect them.
 */
export interface Reporter {
  report(event: ProgressEvent): void;
}
