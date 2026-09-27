import type {
  ChecklistAnswer,
  Grade,
  GradeDetail,
  Review,
  Run,
  TaskSummary,
} from '@placebo-eval/core/results';
import { ArmLabel, useReport } from '../context.js';
import { armName, graderLabel, runOrdinal, type RunFilter } from '../data/model.js';
import { formatDuration } from '../format.js';
import { toHash } from '../route.js';

type DetailOf<T extends GradeDetail['type']> = Extract<GradeDetail, { type: T }>;

function scoreText(grade: Grade): string {
  if (grade.passed !== undefined) return grade.passed ? 'pass' : 'fail';
  const answers =
    grade.detail.type === 'judge' || grade.detail.type === 'review'
      ? grade.detail.answers
      : undefined;
  if (answers !== undefined) return `${String(grade.score)} of ${String(answers.length)} yes`;
  if (grade.grader.type === 'comparison') return grade.score >= 1 ? 'won' : 'lost';
  return `score ${String(grade.score)}`;
}

export function Grades({
  run,
  task,
  filter,
}: {
  readonly run: Run;
  readonly task: TaskSummary | undefined;
  readonly filter: RunFilter;
}) {
  const { index } = useReport();
  const gradedReviews = new Set(
    run.grades.flatMap((grade) => (grade.detail.type === 'review' ? [grade.detail.reviewId] : [])),
  );
  const extraReviews = (index.reviewsByRun.get(run.id) ?? []).filter(
    (review) => !gradedReviews.has(review.id),
  );
  if (run.grades.length === 0 && extraReviews.length === 0) {
    return <p className="quiet">No grader scored this run.</p>;
  }
  return (
    <div className="grades">
      {run.grades.map((grade, i) => (
        <article key={i} className={`grade grade-${grade.kind}`}>
          <header className="grade-head">
            <h4>{graderLabel(grade, task)}</h4>
            <span
              className={`grade-score ${grade.passed === true ? 'pass' : grade.passed === false ? 'fail' : ''}`}
            >
              {scoreText(grade)}
            </span>
          </header>
          <GradeBody detail={grade.detail} filter={filter} />
        </article>
      ))}
      {extraReviews.map((review) => (
        <article key={review.id} className="grade grade-review">
          <header className="grade-head">
            <h4>review</h4>
          </header>
          <ReviewBody review={review} filter={filter} />
        </article>
      ))}
    </div>
  );
}

function GradeBody({
  detail,
  filter,
}: {
  readonly detail: GradeDetail;
  readonly filter: RunFilter;
}) {
  switch (detail.type) {
    case 'command':
      return <CommandBody detail={detail} />;
    case 'check':
      return <p>{detail.message}</p>;
    case 'judge':
      return <JudgeBody detail={detail} filter={filter} />;
    case 'review':
      return (
        <>
          <p className="grade-by">Reviewed by {detail.reviewer}</p>
          {detail.opponentRunId !== undefined && (
            <Opponent runId={detail.opponentRunId} filter={filter} />
          )}
          {detail.answers !== undefined && <Answers answers={detail.answers} />}
        </>
      );
  }
}

function CommandBody({ detail }: { readonly detail: DetailOf<'command'> }) {
  return (
    <>
      <dl className="facts">
        <div>
          <dt>Command</dt>
          <dd className="code">{detail.command}</dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{detail.exitCode ?? 'none'}</dd>
        </div>
        <div>
          <dt>Took</dt>
          <dd>{formatDuration(detail.durationMs)}</dd>
        </div>
      </dl>
      <Output label="stdout" text={detail.stdout} />
      <Output label="stderr" text={detail.stderr} />
    </>
  );
}

function Output({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <figure className="output">
      <figcaption>{label}</figcaption>
      {text === '' ? <p className="quiet">empty</p> : <pre>{text}</pre>}
    </figure>
  );
}

function JudgeBody({
  detail,
  filter,
}: {
  readonly detail: DetailOf<'judge'>;
  readonly filter: RunFilter;
}) {
  return (
    <>
      <p className="grade-by">Judged by {detail.model}</p>
      {detail.opponentRunId !== undefined && (
        <Opponent runId={detail.opponentRunId} shownAs={detail.shownAs} filter={filter} />
      )}
      {detail.answers !== undefined && <Answers answers={detail.answers} />}
      <p className="reasoning">{detail.reasoning}</p>
    </>
  );
}

function Opponent({
  runId,
  shownAs,
  filter,
}: {
  readonly runId: string;
  readonly shownAs?: 'a' | 'b' | undefined;
  readonly filter: RunFilter;
}) {
  const { index } = useReport();
  const opponent = index.runsById.get(runId);
  return (
    <p className="opponent">
      Compared with{' '}
      {opponent === undefined ? (
        <span className="code">{runId}</span>
      ) : (
        <a href={toHash({ view: 'run', runId, filter })}>
          run {runOrdinal(opponent, index.results.runs)} of{' '}
          <ArmLabel name={armName(opponent.arm)} />
        </a>
      )}
      {shownAs !== undefined && (
        <>
          ; this run was shown as <strong>{shownAs}</strong>, the other as{' '}
          <strong>{shownAs === 'a' ? 'b' : 'a'}</strong>
        </>
      )}
      .
    </p>
  );
}

function Answers({ answers }: { readonly answers: readonly ChecklistAnswer[] }) {
  return (
    <ol className="answers">
      {answers.map((answer, i) => (
        <li key={i}>
          <span className={answer.yes ? 'answer yes' : 'answer no'}>
            {answer.yes ? 'yes' : 'no'}
          </span>
          <span className="question">{answer.question}</span>
          {answer.note !== undefined && <span className="note">{answer.note}</span>}
        </li>
      ))}
    </ol>
  );
}

function ReviewBody({ review, filter }: { readonly review: Review; readonly filter: RunFilter }) {
  const { answer } = review;
  return (
    <>
      <p className="grade-by">Reviewed by {review.reviewer}</p>
      {answer.type === 'checklist' ? (
        <Answers answers={answer.answers} />
      ) : (
        <>
          <Opponent runId={answer.opponentRunId} filter={filter} />
          <p>{answer.won ? 'Preferred this run.' : 'Preferred the other run.'}</p>
          {answer.note !== undefined && <p className="reasoning">{answer.note}</p>}
        </>
      )}
    </>
  );
}
