/** One line of a unified diff, with its line numbers on each side. */
interface DiffLine {
  readonly kind: 'context' | 'add' | 'del' | 'hunk' | 'note';
  readonly text: string;
  readonly oldNo?: number;
  readonly newNo?: number;
}

export interface DiffFile {
  readonly path: string;
  readonly status: 'added' | 'deleted' | 'modified' | 'renamed';
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff (as produced by `git diff`) into files with numbered lines. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: {
    path: string;
    status: DiffFile['status'];
    added: number;
    removed: number;
    lines: DiffLine[];
  } | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const flush = () => {
    if (current !== null) files.push(current);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = / b\/(.+)$/.exec(line);
      current = {
        path: match?.[1] ?? line.slice(11),
        status: 'modified',
        added: 0,
        removed: 0,
        lines: [],
      };
      inHunk = false;
      continue;
    }
    if (current === null) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) current.status = 'added';
      else if (line.startsWith('deleted file mode')) current.status = 'deleted';
      else if (line.startsWith('rename to ')) {
        current.status = 'renamed';
        current.path = line.slice('rename to '.length);
      } else if (line.startsWith('Binary files')) current.lines.push({ kind: 'note', text: line });
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      current.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      current.added += 1;
      current.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      current.removed += 1;
      current.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith('\\')) {
      current.lines.push({ kind: 'note', text: line.slice(2) });
    }
  }
  flush();
  return files;
}
