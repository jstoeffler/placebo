import type { Grade } from '../domain/grade.js';
import { hiddenFileSource } from '../domain/run-key.js';
import type { GraderSpec } from '../domain/suite.js';
import type { HiddenFile } from '../ports/executor.js';
import { RunnerInfraError } from '../ports/runner.js';
import { gradeChecklist } from './checklist.js';
import { gradeCommand } from './command.js';
import type { GradingContext } from './context.js';
import { evidenceOf } from './evidence.js';
import { gradeFileExists } from './file-exists.js';
import type { CommandEvidence } from './judge-prompts.js';
import { gradeFileModified } from './file-modified.js';
import { errorGrade, refOf } from './grades.js';
import { GradingInfraError, spendBefore, stoppedGradingMessage } from './grading-infra-error.js';
import { messageOf } from './judge.js';
import { gradeRegex } from './regex.js';
import { gradeToolUsed } from './tool-used.js';

/**
 * Grades one finished run with every grader of its task except `comparison` (see
 * `gradeComparisons`). The caller guarantees the agent has finished: this is the moment hidden
 * files enter the run folder, and they must never be there while the agent works.
 *
 * Order:
 * 1. The `hidden` files of every `command` grader are read from `.placebo/tasks/<task id>/` and
 *    injected together, once. If that fails, every `command` grader gets an error grade instead
 *    of running without its hidden files.
 * 2. Deterministic graders, in declaration order.
 * 3. Checklist judges, in declaration order, seeing the command graders' results.
 *
 * Grades are returned in declaration order. A grader that cannot produce a score yields an error
 * grade scored 0. A judge stopped by `RunnerInfraError` makes grading throw a `GradingInfraError`
 * with the same reason, so the caller can retry, carrying the grades to save if it gives up:
 * those produced, and an error grade for that judge (with what it spent) and every later one.
 */
export async function gradeRun(ctx: GradingContext): Promise<Grade[]> {
  const injectionError = await injectHiddenFiles(ctx);
  const grades = new Map<number, Grade>();
  const commands: CommandEvidence[] = [];

  for (const [index, spec] of ctx.task.graders.entries()) {
    const ref = refOf(spec, index);
    switch (spec.type) {
      case 'command': {
        const grade =
          injectionError === undefined
            ? await gradeCommand(spec, ref, ctx)
            : errorGrade(ref, 'deterministic', injectionError);
        grades.set(index, grade);
        commands.push(evidenceOf(spec.run, grade));
        break;
      }
      case 'file_exists':
        grades.set(index, await gradeFileExists(spec, ref, ctx));
        break;
      case 'file_modified':
        grades.set(index, gradeFileModified(spec, ref, ctx.change));
        break;
      case 'regex':
        grades.set(index, gradeRegex(spec, ref, ctx));
        break;
      case 'tool_used':
        grades.set(index, gradeToolUsed(spec, ref, ctx.events));
        break;
      case 'checklist':
      case 'comparison':
        break;
    }
  }

  const checklists = [...ctx.task.graders.entries()].filter(
    (entry): entry is [number, Extract<GraderSpec, { type: 'checklist' }>] =>
      entry[1].type === 'checklist',
  );
  for (const [position, [index, spec]] of checklists.entries()) {
    try {
      grades.set(index, await gradeChecklist(spec, refOf(spec, index), ctx, commands));
    } catch (error) {
      if (!(error instanceof RunnerInfraError)) throw error;
      const message = stoppedGradingMessage(error);
      grades.set(index, errorGrade(refOf(spec, index), 'judge', message, spendBefore(error)));
      for (const [later, laterSpec] of checklists.slice(position + 1)) {
        grades.set(later, errorGrade(refOf(laterSpec, later), 'judge', message));
      }
      throw new GradingInfraError(error, inOrder(grades));
    }
  }

  return inOrder(grades);
}

function inOrder(grades: ReadonlyMap<number, Grade>): Grade[] {
  return [...grades.entries()].sort(([a], [b]) => a - b).map(([, grade]) => grade);
}

/** Injects every hidden file of the task once; returns why it failed, if it did. */
async function injectHiddenFiles(ctx: GradingContext): Promise<string | undefined> {
  const paths = new Set<string>();
  for (const spec of ctx.task.graders) {
    if (spec.type === 'command') for (const path of spec.hidden ?? []) paths.add(path);
  }
  if (paths.size === 0) return undefined;
  try {
    const files: HiddenFile[] = [];
    for (const path of paths) {
      files.push({ path, content: await ctx.suiteFiles(hiddenFileSource(ctx.task.id, path)) });
    }
    await ctx.executor.injectHidden(ctx.runFolder, files);
    return undefined;
  } catch (error) {
    return `hidden files could not be injected: ${messageOf(error)}`;
  }
}
