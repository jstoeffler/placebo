import { z } from 'zod';

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const SLUG_MESSAGE =
  'must be lowercase letters, digits, "-" or "_", starting with a letter or digit';

/** Identifies one experiment. */
export const ExperimentId = z.string().min(1).brand<'ExperimentId'>();
export type ExperimentId = z.infer<typeof ExperimentId>;

/** Identifies one run. */
export const RunId = z.string().min(1).brand<'RunId'>();
export type RunId = z.infer<typeof RunId>;

/** Identifies one review. */
export const ReviewId = z.string().min(1).brand<'ReviewId'>();
export type ReviewId = z.infer<typeof ReviewId>;

/** A task id as written in the suite. */
export const TaskId = z
  .string()
  .regex(SLUG, { error: `task id ${SLUG_MESSAGE}` })
  .brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskId>;

/** A variant name as written in the suite; `control` is reserved for the control arm. */
export const VariantName = z
  .string()
  .regex(SLUG, { error: `variant name ${SLUG_MESSAGE}` })
  .refine((name) => name !== 'control', { error: 'variant name "control" is reserved' })
  .brand<'VariantName'>();
export type VariantName = z.infer<typeof VariantName>;

/** A lowercase hex SHA-256 digest. */
export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: 'must be a lowercase hex SHA-256 digest' })
  .brand<'Sha256'>();
export type Sha256 = z.infer<typeof Sha256>;

/** A full git commit id (SHA-1 or SHA-256 object format). */
export const CommitSha = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, { error: 'must be a full lowercase commit id' })
  .brand<'CommitSha'>();
export type CommitSha = z.infer<typeof CommitSha>;
