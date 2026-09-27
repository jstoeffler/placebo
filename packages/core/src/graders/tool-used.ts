import type { RunnerEvent } from '../domain/events.js';
import type { Grade, GraderRef } from '../domain/grade.js';
import type { GraderSpec } from '../domain/suite.js';
import { checkGrade } from './grades.js';

type ToolUsedSpec = Extract<GraderSpec, { type: 'tool_used' }>;

/** Passes if the agent called `spec.tool` (exact name) at least once. */
export function gradeToolUsed(
  spec: ToolUsedSpec,
  ref: GraderRef,
  events: readonly RunnerEvent[],
): Grade {
  const calls = events.filter((e) => e.type === 'tool_call' && e.name === spec.tool).length;
  return checkGrade(ref, calls > 0, `${spec.tool} was called ${String(calls)} time(s)`);
}
