import { z } from 'zod';
import { ExperimentId, RunId, TaskId } from '../kernel/ids.js';
import { Arm } from './arm.js';
import { Change } from './change.js';
import { Outcome, RunnerEvent } from './events.js';
import { Grade } from './grade.js';
import { Measurements } from './measurements.js';
import { RunKey } from './run-key.js';

/** One execution of one task with one arm, from a fresh run folder to a stored result. */
export const Run = z.strictObject({
  id: RunId,
  experimentId: ExperimentId,
  key: RunKey,
  taskId: TaskId,
  arm: Arm,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  outcome: Outcome,
  measurements: Measurements,
  events: z.array(RunnerEvent),
  change: Change,
  grades: z.array(Grade),
  /** Absolute path of the kept run folder; absent once removed. */
  runFolder: z.string().optional(),
  /** Retries caused by infrastructure errors only (ADR 0008), never by agent behavior. */
  infraRetries: z.int().nonnegative(),
});
export type Run = z.infer<typeof Run>;
