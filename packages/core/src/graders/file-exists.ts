import type { Grade, GraderRef } from '../domain/grade.js';
import type { GraderSpec } from '../domain/suite.js';
import type { GradingContext } from './context.js';
import { checkGrade, errorGrade } from './grades.js';
import { messageOf } from './judge.js';

type FileExistsSpec = Extract<GraderSpec, { type: 'file_exists' }>;

/**
 * Passes if `spec.path` exists in the run folder. Checked with `test -e` through the executor,
 * because graders reach the run folder only through ports (it may live in a container later).
 * Hidden files are injected before this runs, so a hidden path always exists.
 */
export async function gradeFileExists(
  spec: FileExistsSpec,
  ref: GraderRef,
  ctx: Pick<GradingContext, 'executor' | 'runFolder'>,
): Promise<Grade> {
  try {
    const result = await ctx.executor.exec(ctx.runFolder, `test -e ${shellQuote(spec.path)}`);
    const exists = result.exitCode === 0;
    return checkGrade(ref, exists, `${spec.path} ${exists ? 'exists' : 'does not exist'}`);
  } catch (error) {
    return errorGrade(ref, 'deterministic', `could not check ${spec.path}: ${messageOf(error)}`);
  }
}

/** Single-quotes `value` for `sh`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
