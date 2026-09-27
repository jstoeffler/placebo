import type { Change } from '@placebo-eval/core/results';
import { parseDiff, type DiffFile } from '../diff.js';
import { formatBytes } from '../format.js';

export function ChangeView({ change }: { readonly change: Change }) {
  if (change.diff.trim() === '') {
    return <p className="quiet">The agent left no change.</p>;
  }
  const files = parseDiff(change.diff);
  return (
    <div className="change">
      <p className="quiet">
        {files.length} {files.length === 1 ? 'file' : 'files'}, {formatBytes(change.bytes)} of
        unified diff
      </p>
      {files.map((file) => (
        <FileDiff key={file.path} file={file} />
      ))}
    </div>
  );
}

const STATUS_WORD: Readonly<Record<DiffFile['status'], string>> = {
  added: 'new file',
  deleted: 'deleted',
  modified: '',
  renamed: 'renamed',
};

function FileDiff({ file }: { readonly file: DiffFile }) {
  return (
    <details className="diff-file" open>
      <summary>
        <span className="diff-path">{file.path}</span>
        {STATUS_WORD[file.status] !== '' && <span className="tag">{STATUS_WORD[file.status]}</span>}
        <span className="diff-counts">
          <span className="count-add">+{file.added}</span>{' '}
          <span className="count-del">−{file.removed}</span>
        </span>
      </summary>
      <div className="diff-scroll">
        <table className="diff">
          <tbody>
            {file.lines.map((line, i) => (
              <tr key={i} className={`line line-${line.kind}`}>
                {line.kind === 'hunk' || line.kind === 'note' ? (
                  <td colSpan={3} className="line-hunk-text">
                    {line.text}
                  </td>
                ) : (
                  <>
                    <td className="ln" aria-hidden="true">
                      {line.oldNo}
                    </td>
                    <td className="ln" aria-hidden="true">
                      {line.newNo}
                    </td>
                    <td className="code">
                      <span
                        className="marker"
                        aria-label={
                          line.kind === 'add'
                            ? 'added'
                            : line.kind === 'del'
                              ? 'removed'
                              : undefined
                        }
                      >
                        {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                      </span>
                      {line.text}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
