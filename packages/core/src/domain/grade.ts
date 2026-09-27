import { z } from 'zod';
import { ReviewId, RunId } from '../kernel/ids.js';
import { ChecklistAnswer } from './review.js';
import { GRADER_TYPES } from './suite.js';

/**
 * Which grader produced a grade: the spec's `type` and its position in the task's `graders`.
 * Reviews are not declared in `graders`, so their `index` is null.
 */
export const GraderRef = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(GRADER_TYPES), index: z.int().nonnegative() }),
  z.strictObject({ type: z.literal('review'), index: z.null() }),
]);
export type GraderRef = z.infer<typeof GraderRef>;

/** Why a grade has its score; shown next to the change in the report. */
export const GradeDetail = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('command'),
    command: z.string(),
    exitCode: z.int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  /** `file_exists`, `file_modified`, `regex`, `tool_used`: what was checked and found. */
  z.strictObject({ type: z.literal('check'), message: z.string() }),
  z.strictObject({
    type: z.literal('judge'),
    model: z.string(),
    reasoning: z.string(),
    /** The schema-enforced answer of each repeat, verbatim. */
    raw: z.array(z.unknown()),
    /** Checklist judges: the final answer per question. */
    answers: z.array(ChecklistAnswer).optional(),
    /** Comparison judges: the run this run was compared with, and this run's blinded label. */
    opponentRunId: RunId.optional(),
    shownAs: z.enum(['a', 'b']).optional(),
  }),
  /**
   * A comparison judge's verdict for the run the grade is stored on (always a treatment run):
   * which run it was compared with, the blinded label it was shown under, and whether the judge
   * preferred it. With repeats, `preferred` is the majority and `reason` joins every repeat's.
   */
  z.strictObject({
    type: z.literal('comparison'),
    opponentRunId: RunId,
    position: z.enum(['a', 'b']),
    preferred: z.boolean(),
    reason: z.string(),
    model: z.string(),
    /** The schema-enforced answer of each repeat, verbatim. */
    raw: z.array(z.unknown()),
  }),
  /** The grader could not produce a score (command failed to spawn, judge answer invalid, ...); scored 0. */
  z.strictObject({ type: z.literal('error'), message: z.string() }),
  z.strictObject({
    type: z.literal('review'),
    reviewId: ReviewId,
    reviewer: z.string(),
    answers: z.array(ChecklistAnswer).optional(),
    opponentRunId: RunId.optional(),
  }),
]);
export type GradeDetail = z.infer<typeof GradeDetail>;

/**
 * A grader's score for one run. Deterministic grades pass or fail (score 1 or 0); checklist
 * grades score the count of yes; comparison grades score 1 for a win and 0 for a loss.
 * A `review` grade sits next to the others and never replaces them.
 */
export const Grade = z.strictObject({
  grader: GraderRef,
  kind: z.enum(['deterministic', 'judge', 'review']),
  score: z.number(),
  passed: z.boolean().optional(),
  detail: GradeDetail,
});
export type Grade = z.infer<typeof Grade>;
