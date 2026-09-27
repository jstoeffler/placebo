import type { Change } from '../domain/change.js';
import type { RunnerEvent } from '../domain/events.js';
import type { Grade, GraderRef } from '../domain/grade.js';
import type { GraderSpec } from '../domain/suite.js';
import { checkGrade } from './grades.js';
import { transcriptOf } from './transcript.js';

type RegexSpec = Extract<GraderSpec, { type: 'regex' }>;

const SHOWN_MATCH = 200;

/**
 * Passes if `spec.pattern` matches the change's unified diff (`on: change`) or the transcript
 * (`on: transcript`, see `transcriptOf`). The pattern is compiled with the `m` flag only, so `^`
 * and `$` match at line boundaries; it is case-sensitive.
 */
export function gradeRegex(
  spec: RegexSpec,
  ref: GraderRef,
  input: { readonly change: Change; readonly events: readonly RunnerEvent[] },
): Grade {
  const text = spec.on === 'change' ? input.change.diff : transcriptOf(input.events);
  const match = new RegExp(spec.pattern, 'm').exec(text);
  const where = `the ${spec.on}`;
  if (match === null) return checkGrade(ref, false, `/${spec.pattern}/ did not match ${where}`);
  const shown = match[0].length > SHOWN_MATCH ? `${match[0].slice(0, SHOWN_MATCH)}…` : match[0];
  return checkGrade(ref, true, `/${spec.pattern}/ matched ${where}: ${JSON.stringify(shown)}`);
}
