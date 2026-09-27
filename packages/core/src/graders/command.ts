import type { Grade, GraderRef } from '../domain/grade.js';
import type { GraderSpec } from '../domain/suite.js';
import type { GradingContext } from './context.js';
import { deterministicGrade, errorGrade } from './grades.js';
import { messageOf } from './judge.js';

type CommandSpec = Extract<GraderSpec, { type: 'command' }>;

/**
 * Runs `spec.run` in the run folder through the executor; passes on exit code 0. Hidden files
 * are already injected (see `gradeRun`). A command that cannot be started yields an error grade.
 */
export async function gradeCommand(
  spec: CommandSpec,
  ref: GraderRef,
  ctx: Pick<GradingContext, 'executor' | 'runFolder'>,
): Promise<Grade> {
  try {
    const result = await ctx.executor.exec(ctx.runFolder, spec.run);
    return deterministicGrade(ref, result.exitCode === 0, {
      type: 'command',
      command: spec.run,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    });
  } catch (error) {
    return errorGrade(
      ref,
      'deterministic',
      `command "${spec.run}" could not run: ${messageOf(error)}`,
    );
  }
}
