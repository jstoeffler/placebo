import type { Run } from '@placebo-eval/core/results';
import { useEffect, useRef } from 'react';
import { ArmLabel, useReport } from '../context.js';
import {
  armName,
  filterRuns,
  OUTCOME_LABEL,
  OUTCOMES,
  runOrdinal,
  type RunFilter,
} from '../data/model.js';
import { formatCount, formatCurrency, formatDuration, formatTimestamp } from '../format.js';
import { navigate, toHash } from '../route.js';
import { ChangeView } from './ChangeView.js';
import { Grades } from './Grades.js';
import { Timeline } from './Timeline.js';

export function RunDetail({
  runId,
  filter,
}: {
  readonly runId: string;
  readonly filter: RunFilter;
}) {
  const { index, mode } = useReport();
  const run = index.runsById.get(runId);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [runId]);

  const siblings = filterRuns(index.results.runs, filter);
  const position = siblings.findIndex((candidate) => candidate.id === runId);
  const previous = position > 0 ? siblings[position - 1] : undefined;
  const next = position >= 0 ? siblings[position + 1] : undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea'))
        return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'j' && next !== undefined)
        navigate({ view: 'run', runId: next.id, filter });
      if (event.key === 'k' && previous !== undefined)
        navigate({ view: 'run', runId: previous.id, filter });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [next, previous, filter]);

  if (run === undefined) {
    return (
      <section>
        <h2>Run not found</h2>
        <p>
          This report has no run with id <span className="code">{runId}</span>.{' '}
          <a href={toHash({ view: 'runs', filter })}>Back to runs</a>
        </p>
      </section>
    );
  }
  const task = index.tasksById.get(run.taskId);
  return (
    <article className="run-detail" aria-labelledby="run-heading">
      <nav className="run-nav" aria-label="Runs in this list">
        <a href={toHash({ view: 'runs', filter })}>All runs{describeFilter(filter)}</a>
        <span className="run-position">
          {position >= 0 ? `${String(position + 1)} of ${String(siblings.length)}` : ''}
        </span>
        <span className="run-steps">
          {previous === undefined ? (
            <span className="disabled">Previous</span>
          ) : (
            <a href={toHash({ view: 'run', runId: previous.id, filter })} rel="prev">
              Previous
            </a>
          )}
          {next === undefined ? (
            <span className="disabled">Next</span>
          ) : (
            <a href={toHash({ view: 'run', runId: next.id, filter })} rel="next">
              Next
            </a>
          )}
        </span>
      </nav>

      <header className="run-head">
        <h2 id="run-heading" ref={heading} tabIndex={-1}>
          {run.taskId}{' '}
          <span className="run-sub">
            <ArmLabel name={armName(run.arm)} />, run {runOrdinal(run, index.results.runs)}
          </span>
        </h2>
        <RunFacts run={run} />
        {task !== undefined && <blockquote className="prompt">{task.prompt}</blockquote>}
      </header>

      {mode === 'review' && (
        // The review panel of `placebo review` mounts here; review mode is not built yet.
        <section className="review-slot" data-slot="review" aria-label="Review" />
      )}

      <section className="change-and-grades" aria-label="Change and grades">
        <div className="change-column">
          <h3>Change</h3>
          <ChangeView change={run.change} />
        </div>
        <div className="grades-column">
          <h3>Grades</h3>
          <Grades run={run} task={task} filter={filter} />
        </div>
      </section>

      <section aria-labelledby="timeline-heading">
        <h3 id="timeline-heading">Timeline</h3>
        <p className="quiet">
          Every event in order. Open a tool call to read its full input and result.
        </p>
        <Timeline events={run.events} />
      </section>
    </article>
  );
}

function describeFilter(filter: RunFilter): string {
  const outcome = OUTCOMES.find((candidate) => candidate === filter.outcome);
  const parts = [
    filter.task,
    filter.arm,
    outcome === undefined ? undefined : OUTCOME_LABEL[outcome],
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

function RunFacts({ run }: { readonly run: Run }) {
  const m = run.measurements;
  const facts: [string, string][] = [
    ['Outcome', OUTCOME_LABEL[run.outcome]],
    ['Cost', formatCurrency(m.costUsd)],
    ['Turns', String(m.turns)],
    ['Duration', formatDuration(m.durationMs)],
    ['Tokens in', formatCount(m.tokens.input)],
    ['Tokens out', formatCount(m.tokens.output)],
    ['Cache read', formatCount(m.tokens.cacheRead)],
    ['Cache write', formatCount(m.tokens.cacheWrite)],
    ['Tool calls', String(m.toolCalls.total)],
    ['Files read', String(m.filesRead)],
    ['Files touched', String(m.filesTouched)],
    ['Started', formatTimestamp(run.startedAt)],
  ];
  if (run.infraRetries > 0) facts.push(['Infrastructure retries', String(run.infraRetries)]);
  return (
    <dl className="facts run-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={label === 'Outcome' ? `outcome outcome-${run.outcome}` : undefined}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
