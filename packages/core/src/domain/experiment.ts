import { z } from 'zod';
import { CommitSha, ExperimentId, Sha256, TaskId } from '../kernel/ids.js';
import { MAX_SEED } from '../kernel/random.js';
import { Arm } from './arm.js';

/** The values that must match for two results to be comparable. */
export const Pins = z.strictObject({
  commit: CommitSha,
  subjectModel: z.string().min(1),
  judgeModel: z.string().min(1),
  claudeCodeVersion: z.string().min(1),
  suiteHash: Sha256,
  placeboVersion: z.string().min(1),
});
export type Pins = z.infer<typeof Pins>;

/** One execution of a suite: every task with every arm, repeated `runsPerTask` times. */
export const Experiment = z.strictObject({
  id: ExperimentId,
  createdAt: z.iso.datetime(),
  pins: Pins,
  runsPerTask: z.int().positive(),
  taskIds: z.array(TaskId).min(1),
  /** Control first, then treatments in suite order. */
  arms: z.array(Arm).min(2),
  /** Seed of every random choice in the experiment: run order, pairing, blinding, resampling. */
  seed: z.int().min(0).max(MAX_SEED),
});
export type Experiment = z.infer<typeof Experiment>;
