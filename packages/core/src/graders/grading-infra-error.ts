import type { Grade, JudgeSpend } from '../domain/grade.js';
import type { RunId } from '../kernel/ids.js';
import { RunnerInfraError } from '../ports/runner.js';

function wrapping(error: RunnerInfraError): { cause: unknown; retryAfterMs?: number } {
  return {
    cause: error,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}

/**
 * A judge stopped on `RunnerInfraError`; `spend` is what its calls that returned before the error
 * cost, absent when none did. Same reason, message and retry hint as the error it wraps.
 */
export class JudgeInfraError extends RunnerInfraError {
  readonly spend: JudgeSpend | undefined;

  constructor(error: RunnerInfraError, spend: JudgeSpend | undefined) {
    super(error.reason, error.message, wrapping(error));
    this.spend = spend;
  }
}

/**
 * Grading one run stopped on `RunnerInfraError`. `grades` is the run's grade list for a caller
 * that gives up: every grade produced, then an error grade for each grader that could not run.
 * Same reason, message and retry hint as the error it wraps, so a caller can also retry.
 */
export class GradingInfraError extends RunnerInfraError {
  readonly grades: Grade[];

  constructor(error: RunnerInfraError, grades: Grade[]) {
    super(error.reason, error.message, wrapping(error));
    this.grades = grades;
  }
}

/** Like {@link GradingInfraError}, for the comparisons of one task and treatment. */
export class ComparisonInfraError extends RunnerInfraError {
  readonly grades: { readonly runId: RunId; readonly grade: Grade }[];

  constructor(error: RunnerInfraError, grades: { readonly runId: RunId; readonly grade: Grade }[]) {
    super(error.reason, error.message, wrapping(error));
    this.grades = grades;
  }
}

/** The message of an error grade for a grader that could not run because of `error`. */
export function stoppedGradingMessage(error: RunnerInfraError): string {
  return `grading stopped on an infrastructure error (${error.reason}): ${error.message}`;
}

/** What a judge had spent before `error`, when it says. */
export function spendBefore(error: RunnerInfraError): JudgeSpend | undefined {
  return error instanceof JudgeInfraError ? error.spend : undefined;
}
