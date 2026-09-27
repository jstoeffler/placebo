import { describe, expect, it } from 'vitest';
import { sha256 } from '../kernel/hash.js';
import { sampleRunKey } from '../testing/fixtures.js';
import {
  hashRunKey,
  hashSuite,
  hashTask,
  hashVariant,
  hiddenFileSource,
  RunKey,
  taskFilePaths,
} from './run-key.js';
import { Suite, Task } from './suite.js';

const task = Task.parse({
  id: 'refund-rounding',
  prompt: 'Fix the rounding.',
  graders: [
    { type: 'command', run: 'pnpm vitest run', hidden: ['tests/hidden/refund.spec.ts'] },
    { type: 'checklist', questions: 'tasks/refund-rounding/checklist.md' },
    { type: 'regex', pattern: 'round' },
  ],
  review: { questions: 'tasks/refund-rounding/checklist.md' },
});

const files = new Map<string, string | Uint8Array>([
  ['tasks/refund-rounding/tests/hidden/refund.spec.ts', 'test("refund")'],
  ['tasks/refund-rounding/checklist.md', '- Rounds half up?'],
  ['variants/none.patch', 'diff --git a/CLAUDE.md b/CLAUDE.md'],
]);

describe('taskFilePaths', () => {
  it('lists hidden files under the task folder and question files once, sorted', () => {
    expect(taskFilePaths(task)).toEqual([
      'tasks/refund-rounding/checklist.md',
      'tasks/refund-rounding/tests/hidden/refund.spec.ts',
    ]);
    expect(hiddenFileSource('t', 'a/b.ts')).toBe('tasks/t/a/b.ts');
  });

  it('is empty for a task with no referenced files', () => {
    expect(
      taskFilePaths(Task.parse({ id: 't', prompt: 'p', graders: [{ type: 'command', run: 'x' }] })),
    ).toEqual([]);
  });
});

describe('hashTask', () => {
  it('is stable and ignores the task id and default spelling', () => {
    const renamed = Task.parse({
      ...task,
      id: 'other-name',
      graders: [
        task.graders[0],
        task.graders[1],
        { type: 'regex', pattern: 'round', on: 'change' },
      ],
    });
    const renamedFiles = new Map(files);
    renamedFiles.set('tasks/other-name/tests/hidden/refund.spec.ts', 'test("refund")');
    expect(hashTask(renamed, renamedFiles)).toBe(hashTask(task, files));
  });

  it('changes with the prompt, the graders and file contents', () => {
    const base = hashTask(task, files);
    expect(hashTask({ ...task, prompt: 'Fix it.' }, files)).not.toBe(base);
    expect(hashTask({ ...task, graders: task.graders.slice(1) }, files)).not.toBe(base);
    const edited = new Map(files).set('tasks/refund-rounding/checklist.md', '- Keeps signature?');
    expect(hashTask(task, edited)).not.toBe(base);
  });

  it('throws when a referenced file is missing', () => {
    expect(() => hashTask(task, new Map())).toThrow(
      'missing content for suite file "tasks/refund-rounding/tests/hidden/refund.spec.ts"',
    );
  });
});

describe('hashVariant', () => {
  it('hashes patch bytes; control hashes the empty string', () => {
    expect(hashVariant(null)).toBe(sha256(''));
    expect(hashVariant('diff')).toBe(sha256('diff'));
    expect(hashVariant(new TextEncoder().encode('diff'))).toBe(sha256('diff'));
  });
});

describe('hashRunKey', () => {
  it('is independent of key order', () => {
    const reordered = Object.fromEntries(Object.entries(sampleRunKey).reverse());
    expect(hashRunKey(RunKey.parse(reordered))).toBe(hashRunKey(RunKey.parse(sampleRunKey)));
  });

  it('changes with any field', () => {
    const key = RunKey.parse(sampleRunKey);
    expect(hashRunKey({ ...key, claudeCodeVersion: '2.1.284' })).not.toBe(hashRunKey(key));
  });
});

describe('hashSuite', () => {
  const suite = Suite.parse({
    commit: 'abcdef1',
    model: 'm',
    judgeModel: 'j',
    variants: { none: { patch: 'variants/none.patch' } },
    tasks: [task],
  });

  it('covers the suite and every referenced file', () => {
    const base = hashSuite(suite, files);
    expect(hashSuite(Suite.parse({ ...suite, runs: 5 }), files)).toBe(base);
    expect(hashSuite({ ...suite, runs: 6 }, files)).not.toBe(base);
    expect(hashSuite(suite, new Map(files).set('variants/none.patch', 'other'))).not.toBe(base);
  });
});
