import { z } from 'zod';
import { ExperimentId, ReviewId, RunId, TaskId } from '../kernel/ids.js';
import { Change } from './change.js';
import { RunnerEvent } from './events.js';

export const ChecklistAnswer = z.strictObject({
  question: z.string(),
  yes: z.boolean(),
  /** Optional reasoning or comment. */
  note: z.string().optional(),
});
export type ChecklistAnswer = z.infer<typeof ChecklistAnswer>;

/**
 * A person's answers for one run, stored with the reviewer's name. A review is its own grade
 * and never overwrites a deterministic or judge grade.
 */
export const Review = z.strictObject({
  id: ReviewId,
  runId: RunId,
  reviewer: z.string().min(1),
  createdAt: z.iso.datetime(),
  answer: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('checklist'), answers: z.array(ChecklistAnswer) }),
    z.strictObject({
      type: z.literal('comparison'),
      /** The run of the other arm this run was shown against. */
      opponentRunId: RunId,
      /** True if the reviewer preferred `runId` over `opponentRunId`. */
      won: z.boolean(),
      note: z.string().optional(),
    }),
  ]),
});
export type Review = z.infer<typeof Review>;

// --- Review mode: what `placebo review` serves and accepts -------------------------------------
// Blinding holds in these shapes: none has a field that could carry an arm, a variant name, a
// run id, a grade or a measurement, and every object is strict, so none can gain one unnoticed.

/**
 * One command grader's result as a reviewer sees it. `exitCode` is null when the command did
 * not exit normally or could not be run.
 */
export const ReviewCheck = z.strictObject({
  command: z.string(),
  exitCode: z.int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});
export type ReviewCheck = z.infer<typeof ReviewCheck>;

/** Opaque; stands for one run, or one pair of runs, for the life of one review server. */
const ReviewToken = z.string().min(1);

/** One run to review, blinded: `token` stands for the run. */
export const ReviewItem = z.strictObject({
  token: ReviewToken,
  taskId: TaskId,
  prompt: z.string(),
  change: Change,
  checks: z.array(ReviewCheck),
  /** The transcript, for the timeline. */
  events: z.array(RunnerEvent).optional(),
  /** The task's checklist questions, in order; each is answered yes or no. */
  questions: z.array(z.string()).min(1),
  /** True once the session's reviewer has reviewed this run. */
  answered: z.boolean(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/** One side of a comparison. */
export const ReviewSide = z.strictObject({ change: Change, checks: z.array(ReviewCheck) });
export type ReviewSide = z.infer<typeof ReviewSide>;

/**
 * Two runs of one task, one per arm, as `a` and `b` in random order, blinded: `token` stands
 * for the pair.
 */
export const ReviewComparison = z.strictObject({
  token: ReviewToken,
  taskId: TaskId,
  prompt: z.string(),
  a: ReviewSide,
  b: ReviewSide,
  /** True once the session's reviewer has compared this pair. */
  answered: z.boolean(),
});
export type ReviewComparison = z.infer<typeof ReviewComparison>;

/**
 * Everything review mode receives about an experiment. It never holds `Results`, which name
 * arms, so blinding holds in the data and not only in rendering. Unanswered entries come first.
 */
export const ReviewSession = z.strictObject({
  experimentId: ExperimentId,
  /** Null until the reviewer has given a name. */
  reviewer: z.string().min(1).nullable(),
  taskCount: z.int().nonnegative(),
  items: z.array(ReviewItem),
  comparisons: z.array(ReviewComparison),
});
export type ReviewSession = z.infer<typeof ReviewSession>;

/** What review mode posts for one token: checklist answers, or the preferred side of a pair. */
export const ReviewAnswer = z.strictObject({
  token: ReviewToken,
  reviewer: z.string().trim().min(1),
  answer: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('checklist'), answers: z.array(ChecklistAnswer).min(1) }),
    z.strictObject({
      type: z.literal('comparison'),
      preferred: z.enum(['a', 'b']),
      reason: z.string().optional(),
    }),
  ]),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

// --- Agreement ---------------------------------------------------------------------------------

/** How often two sources gave the same answer: `agreed` times out of `compared`. */
export const AgreementCount = z.strictObject({
  compared: z.int().nonnegative(),
  agreed: z.int().nonnegative(),
});
export type AgreementCount = z.infer<typeof AgreementCount>;

/** Agreement on one checklist question of one task. */
export const QuestionAgreement = z.strictObject({
  taskId: TaskId,
  question: z.string(),
  /** Counted once per reviewer and run where both the reviewer and the judge answered. */
  withJudge: AgreementCount,
  /** Counted once per pair of reviewers and run where both answered. */
  betweenReviewers: AgreementCount,
});
export type QuestionAgreement = z.infer<typeof QuestionAgreement>;

/** Agreement on which run of a pair is better, for one task. */
export const ComparisonAgreement = z.strictObject({
  taskId: TaskId,
  /** Counted once per reviewer and pair the judge also compared. */
  withJudge: AgreementCount,
  /** Counted once per pair of reviewers and pair both compared. */
  betweenReviewers: AgreementCount,
});
export type ComparisonAgreement = z.infer<typeof ComparisonAgreement>;

/** Agreement between reviewers and the judge, and between reviewers (brief §9). */
export const Agreement = z.strictObject({
  /** Everyone whose reviews were counted, in order of first review. */
  reviewers: z.array(z.string()),
  questions: z.array(QuestionAgreement),
  comparisons: z.array(ComparisonAgreement),
});
export type Agreement = z.infer<typeof Agreement>;
