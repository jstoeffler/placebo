import type { Run } from '@placebo-eval/core/results';
import { ArmLabel, useReport } from '../context.js';
import {
  armName,
  deterministicTally,
  filterRuns,
  OUTCOME_LABEL,
  OUTCOMES,
  runOrdinal,
  withFilter,
  type RunFilter,
} from '../data/model.js';
import { formatCurrency, formatDuration } from '@placebo-eval/core/format';
import { navigate, toHash } from '../route.js';

export function RunList({ filter }: { readonly filter: RunFilter }) {
  const { index } = useReport();
  const { results } = index;
  const runs = filterRuns(results.runs, filter);
  const setFilter = (key: keyof RunFilter, value: string) => {
    navigate({ view: 'runs', filter: withFilter(filter, key, value) });
  };
  return (
    <section aria-labelledby="runs-heading">
      <div className="section-head">
        <h2 id="runs-heading">Runs</h2>
      </div>
      <form
        className="filters"
        aria-label="Filter runs"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Select
          label="Task"
          value={filter.task ?? ''}
          options={results.experiment.taskIds.map((id) => [id, id])}
          onChange={(value) => {
            setFilter('task', value);
          }}
        />
        <Select
          label="Arm"
          value={filter.arm ?? ''}
          options={index.armNames.map((name) => [name, name])}
          onChange={(value) => {
            setFilter('arm', value);
          }}
        />
        <Select
          label="Outcome"
          value={filter.outcome ?? ''}
          options={OUTCOMES.map((outcome) => [outcome, OUTCOME_LABEL[outcome]])}
          onChange={(value) => {
            setFilter('outcome', value);
          }}
        />
        <p className="count" aria-live="polite">
          {runs.length === results.runs.length
            ? `${String(runs.length)} runs`
            : `${String(runs.length)} of ${String(results.runs.length)} runs`}
        </p>
      </form>
      {runs.length === 0 ? (
        <p className="quiet">No run matches these filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="data runs">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Task</th>
                <th scope="col">Arm</th>
                <th scope="col">Outcome</th>
                <th scope="col">Graders</th>
                <th scope="col" className="num">
                  Cost
                </th>
                <th scope="col" className="num">
                  Turns
                </th>
                <th scope="col" className="num">
                  Duration
                </th>
                <th scope="col" className="num">
                  Files touched
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} all={results.runs} filter={filter} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunRow({
  run,
  all,
  filter,
}: {
  readonly run: Run;
  readonly all: readonly Run[];
  readonly filter: RunFilter;
}) {
  const tally = deterministicTally(run);
  const allPassed = tally.total > 0 && tally.passed === tally.total;
  return (
    <tr>
      <th scope="row">
        <a href={toHash({ view: 'run', runId: run.id, filter })}>Run {runOrdinal(run, all)}</a>
      </th>
      <td>{run.taskId}</td>
      <td>
        <ArmLabel name={armName(run.arm)} />
      </td>
      <td>
        <span className={`outcome outcome-${run.outcome}`}>{OUTCOME_LABEL[run.outcome]}</span>
      </td>
      <td>
        <span className={allPassed ? 'tally pass' : 'tally fail'}>
          {tally.total === 0 ? 'none' : `${String(tally.passed)} of ${String(tally.total)} passed`}
        </span>
      </td>
      <td className="num">{formatCurrency(run.measurements.costUsd)}</td>
      <td className="num">{run.measurements.turns}</td>
      <td className="num">{formatDuration(run.measurements.durationMs)}</td>
      <td className="num">{run.measurements.filesTouched}</td>
    </tr>
  );
}

function Select(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (value: string) => void;
}) {
  const id = `filter-${props.label.toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <select
        id={id}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      >
        <option value="">All</option>
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
