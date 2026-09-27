import type { Arm } from '../domain/arm.js';
import type { Change } from '../domain/change.js';
import type { Outcome, RunnerEvent } from '../domain/events.js';
import type { Task } from '../domain/suite.js';
import type { Clock } from '../kernel/clock.js';
import type { Random } from '../kernel/random.js';
import type { Executor, RunFolder } from '../ports/executor.js';
import type { Runner } from '../ports/runner.js';

/** Reads a suite file by its path relative to `.placebo/`. */
export type SuiteFileReader = (path: string) => Promise<string | Uint8Array>;

/** Everything grading one finished run needs. */
export interface GradingContext {
  readonly task: Task;
  /** Known to the caller for bookkeeping; never shown to a judge (blinding). */
  readonly arm: Arm;
  readonly runFolder: RunFolder;
  readonly executor: Pick<Executor, 'exec' | 'injectHidden' | 'createJudgeFolder' | 'remove'>;
  readonly runner: Runner;
  /** Full model ID of the judge. */
  readonly judgeModel: string;
  readonly change: Change;
  readonly events: readonly RunnerEvent[];
  readonly outcome: Outcome;
  readonly suiteFiles: SuiteFileReader;
  readonly random: Random;
  readonly clock: Clock;
}

/**
 * The parts of a `GradingContext` a judge call needs. Judges never run in the run folder: the
 * executor gives each judge grade its own judge folder, so the variant's files cannot influence
 * its own evaluation (brief §13 item 8), and removes it afterwards.
 */
export interface JudgeContext extends Pick<GradingContext, 'runner' | 'judgeModel'> {
  readonly executor: Pick<Executor, 'createJudgeFolder' | 'remove'>;
}
