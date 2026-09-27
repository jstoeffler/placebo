import { z } from 'zod';
import { ReviewId, RunId } from '../kernel/ids.js';

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
