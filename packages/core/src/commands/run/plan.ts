import { armName, type Arm } from '../../domain/arm.js';
import type { ExperimentId, RunId, TaskId } from '../../kernel/ids.js';
import { MAX_SEED, type Random } from '../../kernel/random.js';

/** One run to perform: a task, an arm and a run index, with the seed of its own random draws. */
export interface RunSlot {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly arm: Arm;
  /** 0-based index among the runs of this task and arm. */
  readonly runIndex: number;
  /** Seeds the run's retry jitter and grading, so they replay whatever order runs finish in. */
  readonly seed: number;
}

/** A run id readable in a terminal: `<experiment>-<task>-<arm>-<n>`, `n` from 1. */
function runIdOf(experimentId: ExperimentId, taskId: TaskId, arm: Arm, runIndex: number): RunId {
  return `${experimentId}-${taskId}-${armName(arm)}-${String(runIndex + 1)}` as RunId;
}

/**
 * Every task × arm × run index, shuffled with `random` so arms interleave and rate limits or
 * time of day hit every arm equally (brief §6, §13 item 9). The same seed gives the same order.
 * Each slot then draws its own seed, in the shuffled order.
 */
export function planRuns(input: {
  readonly experimentId: ExperimentId;
  readonly taskIds: readonly TaskId[];
  readonly arms: readonly Arm[];
  readonly runsPerTask: number;
  readonly random: Random;
}): RunSlot[] {
  const slots: Omit<RunSlot, 'seed'>[] = [];
  for (const taskId of input.taskIds) {
    for (const arm of input.arms) {
      for (let runIndex = 0; runIndex < input.runsPerTask; runIndex++) {
        slots.push({
          runId: runIdOf(input.experimentId, taskId, arm, runIndex),
          taskId,
          arm,
          runIndex,
        });
      }
    }
  }
  return input.random
    .shuffle(slots)
    .map((slot) => ({ ...slot, seed: input.random.int(0, MAX_SEED) }));
}

/**
 * Runs `work` over `items` in order with at most `parallelism` in flight. Once `work` returns
 * `'stop'` for any item, or `shouldStop` turns true, no further item starts; items in flight
 * finish. Resolves when every started item has finished.
 */
export async function runPool<T>(
  items: readonly T[],
  parallelism: number,
  work: (item: T) => Promise<'continue' | 'stop'>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && !shouldStop() && next < items.length) {
      const item = items[next++] as T;
      if ((await work(item)) === 'stop') stopped = true;
    }
  };
  const workers = Math.max(1, Math.min(parallelism, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}
