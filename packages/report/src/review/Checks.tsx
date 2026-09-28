import type { ReviewCheck } from '@placebo-eval/core/results';
import { Output } from '../views/Grades.js';

/** The command graders' results of one run: command, exit code and output. */
export function Checks({ checks }: { readonly checks: readonly ReviewCheck[] }) {
  if (checks.length === 0) return <p className="quiet">No command checked this run.</p>;
  return (
    <div className="grades">
      {checks.map((check, i) => (
        <article key={i} className="grade grade-deterministic">
          <header className="grade-head">
            <h4 className="code">{check.command}</h4>
            <span className={`grade-score ${check.exitCode === 0 ? 'pass' : 'fail'}`}>
              {check.exitCode === 0 ? 'pass' : 'fail'}
            </span>
          </header>
          <dl className="facts">
            <div>
              <dt>Exit code</dt>
              <dd>{check.exitCode ?? 'none'}</dd>
            </div>
          </dl>
          <Output label="stdout" text={check.stdout} />
          <Output label="stderr" text={check.stderr} />
        </article>
      ))}
    </div>
  );
}
