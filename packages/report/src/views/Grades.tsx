import type {
  ChecklistAnswer,
  Grade,
  GradeDetail,
  JudgeSpend,
  Run,
  TaskSummary,
} from '@placebo-eval/core/results';
import { ArmLabel, useReport } from '../context.js';
import { armName, graderLabel, runOrdinal, type RunFilter } from '../data/model.js';
import { formatCurrency, formatDuration, formatTokens } from '@placebo-eval/core/format';
import { toHash } from '../route.js';

type DetailOf<T extends GradeDetail['type']> = Extract<GradeDetail, { type: T }>;

function scoreText(grade: Grade): string {
  if (grade.detail.type === 'error') return 'error';
  if (grade.passed !== undefined) return grade.passed ? 'pass' : 'fail';
  const answers =
    grade.detail.type === 'judge' || grade.detail.type === 'review'
      ? grade.detail.answers
      : undefined;
  if (answers !== undefined) return `${String(grade.score)} of ${String(answers.length)} yes`;
  if (grade.detail.type === 'comparison') return grade.detail.preferred ? 'won' : 'lost';
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
  if (run.grades.length === 0) {
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
      return <JudgeBody detail={detail} />;
    case 'comparison':
      return <ComparisonBody detail={detail} filter={filter} />;
    case 'error':
      return <p className="grade-error">{detail.message}</p>;
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

export function Output({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <figure className="output">
      <figcaption>{label}</figcaption>
      {text === '' ? <p className="quiet">empty</p> : <pre>{text}</pre>}
    </figure>
  );
}

function JudgeBody({ detail }: { readonly detail: DetailOf<'judge'> }) {
  return (
    <>
      <p className="grade-by">Judged by {detail.model}</p>
      {detail.answers !== undefined && <Answers answers={detail.answers} />}
      <p className="reasoning">{detail.reasoning}</p>
      <Spend spend={detail.spend} />
    </>
  );
}

function ComparisonBody({
  detail,
  filter,
}: {
  readonly detail: DetailOf<'comparison'>;
  readonly filter: RunFilter;
}) {
  return (
    <>
      <p className="grade-by">Judged by {detail.model}</p>
      <Opponent runId={detail.opponentRunId} position={detail.position} filter={filter} />
      <p>
        {detail.preferred ? 'The judge preferred this run.' : 'The judge preferred the other run.'}
      </p>
      <p className="reasoning">{detail.reason}</p>
      <Spend spend={detail.spend} />
    </>
  );
}

function Spend({ spend }: { readonly spend: JudgeSpend }) {
  const { tokens } = spend;
  return (
    <dl className="facts">
      <div>
        <dt>Judge cost</dt>
        <dd>{formatCurrency(spend.costUsd)}</dd>
      </div>
      <div>
        <dt>Judge tokens</dt>
        <dd>
          {formatTokens(tokens.input + tokens.cacheRead + tokens.cacheWrite)} in,{' '}
          {formatTokens(tokens.output)} out
        </dd>
      </div>
      <div>
        <dt>Judge calls</dt>
        <dd>{spend.calls}</dd>
      </div>
    </dl>
  );
}

export function Opponent({
  runId,
  position,
  filter,
}: {
  readonly runId: string;
  readonly position?: 'a' | 'b' | undefined;
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
      {position !== undefined && (
        <>
          ; this run was shown as <strong>{position}</strong>, the other as{' '}
          <strong>{position === 'a' ? 'b' : 'a'}</strong>
        </>
      )}
      .
    </p>
  );
}

export function Answers({ answers }: { readonly answers: readonly ChecklistAnswer[] }) {
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
