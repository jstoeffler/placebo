import { describe, expect, it } from 'vitest';
import { parseSuite } from '../index.js';

const MESSAGE =
  'a task takes at most one comparison grader; a second one would count its win rate twice';

function suite(graders: readonly string[], secondTask: readonly string[] = []): string {
  const task = (id: string, list: readonly string[]): string[] => [
    `  - id: ${id}`,
    '    prompt: do it',
    '    graders:',
    ...list.map((grader) => `      - ${grader}`),
  ];
  return [
    'commit: "0123456"',
    'model: claude-sonnet-5',
    'judge_model: claude-opus-5-5',
    'variants:',
    '  none: { patch: variants/none.patch }',
    'tasks:',
    ...task('first', graders),
    ...(secondTask.length === 0 ? [] : task('second', secondTask)),
    '',
  ].join('\n');
}

const COMMAND = '{ type: command, run: pnpm test }';
const COMPARISON = '{ type: comparison }';
const AGENTIC_COMPARISON = '{ type: comparison, agentic: true }';

describe('at most one comparison grader per task', () => {
  it('accepts a task with one comparison grader', () => {
    expect(parseSuite(suite([COMMAND, COMPARISON])).ok).toBe(true);
  });

  it('accepts one comparison grader in each of two tasks', () => {
    expect(parseSuite(suite([COMPARISON], [COMMAND, COMPARISON])).ok).toBe(true);
  });

  it('rejects a second comparison grader, located at the second one', () => {
    const result = parseSuite(suite([COMMAND, COMPARISON, AGENTIC_COMPARISON]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: 'tasks[0].graders[2]', message: MESSAGE },
    ]);
  });

  it('reports every comparison grader after the first', () => {
    const result = parseSuite(suite([COMMAND], [COMPARISON, COMMAND, COMPARISON, COMPARISON]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: 'tasks[1].graders[2]', message: MESSAGE },
      { path: 'tasks[1].graders[3]', message: MESSAGE },
    ]);
  });

  it('gives the line of the offending grader', () => {
    const result = parseSuite(suite([COMPARISON, COMPARISON]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.line).toBe(11);
  });
});
