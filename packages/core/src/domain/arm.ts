import { z } from 'zod';
import { VariantName } from '../kernel/ids.js';

/** The arm that runs the repo exactly as it is at the pinned commit. */
export const ControlArm = z.strictObject({ kind: z.literal('control') });
export type ControlArm = z.infer<typeof ControlArm>;

/** An arm defined by a variant patch applied on top of the snapshot. */
export const TreatmentArm = z.strictObject({
  kind: z.literal('treatment'),
  variant: VariantName,
  /** Variant patch path, relative to `.placebo/`. */
  patch: z.string().min(1),
});
export type TreatmentArm = z.infer<typeof TreatmentArm>;

export const Arm = z.discriminatedUnion('kind', [ControlArm, TreatmentArm]);
export type Arm = z.infer<typeof Arm>;

/** `control` or the variant name; how arms are referred to in results and the report. */
export const ArmName = z.union([z.literal('control'), VariantName]);
export type ArmName = z.infer<typeof ArmName>;

export const CONTROL: ControlArm = { kind: 'control' };

export function armName(arm: Arm): ArmName {
  return arm.kind === 'control' ? 'control' : arm.variant;
}
