import { describe, expect, it } from 'vitest';
import { Grade } from '../domain/grade.js';
import { sampleGrades } from '../testing/fixtures.js';
import { task } from '../testing/grading.js';
import { commandEvidence } from './evidence.js';

const error = Grade.parse({
  grader: { type: 'command', index: 1 },
  kind: 'deterministic',
  score: 0,
  passed: false,
  detail: { type: 'error', message: 'spawn sh ENOENT' },
});

describe('commandEvidence', () => {
  it("names each command by the task's grader, falling back to the stored detail", () => {
    const graded = task({
      graders: [
        { type: 'tool_used', tool: 'Read' },
        { type: 'command', run: 'pnpm lint' },
      ],
    });
    const grades = Grade.array().parse(sampleGrades);
    expect(commandEvidence(graded, [...grades, error])).toEqual([
      { command: 'pnpm vitest run', exitCode: 0, stdout: 'ok', stderr: '' },
      {
        command: 'pnpm lint',
        exitCode: undefined,
        stdout: '',
        stderr: '',
        error: 'spawn sh ENOENT',
      },
    ]);
  });

  it('says so when neither the task nor the detail names the command', () => {
    const graded = task({ graders: [{ type: 'tool_used', tool: 'Read' }] });
    expect(commandEvidence(graded, [error])).toEqual([
      {
        command: 'unknown command',
        exitCode: undefined,
        stdout: '',
        stderr: '',
        error: 'spawn sh ENOENT',
      },
    ]);
  });
});
