import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,3 +3,3 @@ function f() {',
  ' keep',
  '-old',
  '+new',
  ' tail',
  '\\ No newline at end of file',
  'diff --git a/src/b.ts b/src/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  'diff --git a/old.ts b/new.ts',
  'similarity index 100%',
  'rename from old.ts',
  'rename to new.ts',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');

describe('parseDiff', () => {
  const files = parseDiff(DIFF);

  it('splits files and reads their status', () => {
    expect(files.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['src/b.ts', 'added', 2, 0],
      ['new.ts', 'renamed', 0, 0],
      ['gone.ts', 'deleted', 0, 1],
    ]);
  });

  it('numbers lines on both sides', () => {
    expect(files[0]?.lines).toEqual([
      { kind: 'hunk', text: '@@ -3,3 +3,3 @@ function f() {' },
      { kind: 'context', text: 'keep', oldNo: 3, newNo: 3 },
      { kind: 'del', text: 'old', oldNo: 4 },
      { kind: 'add', text: 'new', newNo: 4 },
      { kind: 'context', text: 'tail', oldNo: 5, newNo: 5 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });

  it('is empty for an empty change', () => {
    expect(parseDiff('')).toEqual([]);
  });
});
