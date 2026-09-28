import type { Grade, GradeDetail, GraderRef, JudgeSpend } from '../domain/grade.js';
import type { GraderSpec } from '../domain/suite.js';

/** The ref of the grader declared at `index` of a task's `graders`. */
export function refOf(spec: GraderSpec, index: number): GraderRef {
  return { type: spec.type, index };
}

/** A pass (score 1) or fail (score 0) from a deterministic grader. */
export function deterministicGrade(ref: GraderRef, passed: boolean, detail: GradeDetail): Grade {
  return { grader: ref, kind: 'deterministic', score: passed ? 1 : 0, passed, detail };
}

/** A check that passed or failed, with the message saying what was checked and found. */
export function checkGrade(ref: GraderRef, passed: boolean, message: string): Grade {
  return deterministicGrade(ref, passed, { type: 'check', message });
}

/**
 * A grader that could not produce a score. Scored 0; deterministic ones also fail, judges leave
 * `passed` undefined like every judge grade. `spend` is what a judge spent before failing.
 */
export function errorGrade(
  ref: GraderRef,
  kind: 'deterministic' | 'judge',
  message: string,
  spend?: JudgeSpend,
): Grade {
  const detail: GradeDetail = { type: 'error', message, ...(spend === undefined ? {} : { spend }) };
  return kind === 'deterministic'
    ? deterministicGrade(ref, false, detail)
    : { grader: ref, kind, score: 0, detail };
}
