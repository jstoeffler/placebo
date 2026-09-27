import type { Suite } from '../domain/suite.js';
import type { Warning } from '../domain/warnings.js';

/**
 * A `judge_equals_subject` warning when the judge model is the subject model (brief §13 item 7:
 * a model grading its own work favors it); undefined otherwise. Compares full model IDs exactly.
 */
export function judgeEqualsSubject(
  suite: Pick<Suite, 'model' | 'judgeModel'>,
): Warning | undefined {
  return suite.judgeModel === suite.model
    ? { type: 'judge_equals_subject', model: suite.model }
    : undefined;
}
