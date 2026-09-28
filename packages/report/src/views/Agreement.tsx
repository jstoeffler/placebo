import type { Agreement as AgreementData, AgreementCount } from '@placebo-eval/core/results';
import { useEffect, useRef } from 'react';

/** The address the report opens at after a review pass: the overview, at this section. */
export const AGREEMENT_HASH = '#/agreement';

/** Past this many answers compared, the tally is text only. */
const MAX_MARKS = 40;

/**
 * How often reviewers agreed with the judge and with each other (brief §9). Counts, not shares:
 * with a handful of reviews a percentage would read as more certain than it is.
 */
export function Agreement({ agreement }: { readonly agreement: AgreementData }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Finishing a review pass lands here.
  useEffect(() => {
    if (window.location.hash !== AGREEMENT_HASH) return;
    const frame = requestAnimationFrame(() => {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: 'start' });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <section className="agreement" id="agreement" aria-labelledby="agreement-heading">
      <div className="section-head">
        <h2 id="agreement-heading" ref={heading} tabIndex={-1}>
          Agreement
        </h2>
      </div>
      <p className="quiet">
        {agreement.reviewers.length === 1 ? 'Reviewer' : 'Reviewers'}: {listOf(agreement.reviewers)}
        . Each mark is one answer compared; a filled mark is an agreement.
      </p>

      {agreement.questions.length > 0 && (
        <div className="table-scroll">
          <table className="data agreement-table">
            <caption className="agreement-caption">Checklist questions</caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Question</th>
                <th scope="col">Reviewer and judge</th>
                <th scope="col">Between reviewers</th>
              </tr>
            </thead>
            <tbody>
              {agreement.questions.map((row) => (
                <tr key={`${row.taskId}\n${row.question}`}>
                  <td className="code">{row.taskId}</td>
                  <th scope="row" className="agreement-question">
                    {row.question}
                  </th>
                  <td>
                    <Tally count={row.withJudge} />
                  </td>
                  <td>
                    <Tally count={row.betweenReviewers} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {agreement.comparisons.length > 0 && (
        <div className="table-scroll">
          <table className="data agreement-table">
            <caption className="agreement-caption">
              Comparisons: which of two runs is better
            </caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Reviewer and judge</th>
                <th scope="col">Between reviewers</th>
              </tr>
            </thead>
            <tbody>
              {agreement.comparisons.map((row) => (
                <tr key={row.taskId}>
                  <th scope="row" className="code">
                    {row.taskId}
                  </th>
                  <td>
                    <Tally count={row.withJudge} />
                  </td>
                  <td>
                    <Tally count={row.betweenReviewers} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Tally({ count }: { readonly count: AgreementCount }) {
  if (count.compared === 0) return <span className="none">not compared</span>;
  const text = `${String(count.agreed)} of ${String(count.compared)} agree`;
  return (
    <span className="tally-marks">
      {count.compared <= MAX_MARKS && (
        <span className="marks" aria-hidden="true">
          {Array.from({ length: count.compared }, (_, i) => (
            <span key={i} className={i < count.agreed ? 'mark agreed' : 'mark'} />
          ))}
        </span>
      )}
      <span className="tally-text">{text}</span>
    </span>
  );
}

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}
