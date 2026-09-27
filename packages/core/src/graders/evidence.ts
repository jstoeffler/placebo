import type { Grade } from '../domain/grade.js';
import type { Task } from '../domain/suite.js';
import type { CommandEvidence } from './judge-prompts.js';

/** What a judge is shown of one command grader's result. */
export function evidenceOf(command: string, grade: Grade): CommandEvidence {
  const { detail } = grade;
  if (detail.type === 'command') {
    return { command, exitCode: detail.exitCode, stdout: detail.stdout, stderr: detail.stderr };
  }
  const error = detail.type === 'error' ? detail.message : 'no result';
  return { command, exitCode: undefined, stdout: '', stderr: '', error };
}

/**
 * The command graders' results among a finished run's stored grades (kept in declaration order):
 * what a comparison judge is shown of each attempt's checks.
 */
export function commandEvidence(task: Task, grades: readonly Grade[]): CommandEvidence[] {
  return grades
    .filter((grade) => grade.grader.type === 'command' && grade.kind === 'deterministic')
    .map((grade) => {
      const spec = grade.grader.index === null ? undefined : task.graders[grade.grader.index];
      const command =
        spec?.type === 'command'
          ? spec.run
          : grade.detail.type === 'command'
            ? grade.detail.command
            : 'unknown command';
      return evidenceOf(command, grade);
    });
}
