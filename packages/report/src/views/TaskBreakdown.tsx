import { METRICS, type Metric } from '@placebo-eval/core/results';
import { ArmLabel, useReport } from '../context.js';
import { METRIC_ORDER } from '../data/model.js';
import {
  formatCount,
  formatCurrency,
  formatDuration,
  formatPlain,
  formatShare,
} from '../format.js';
import { toHash } from '../route.js';

const DEAD_TASK_NOTE =
  'Every arm scored zero on this task: it is flagged as unsolvable or brittle and excluded from verdicts.';

/** A per-run mean in the metric's own unit. */
function formatMean(metric: Metric, value: number): string {
  switch (metric) {
    case 'passRate':
    case 'winRate':
      return formatShare(value);
    case 'costUsd':
      return formatCurrency(value);
    case 'tokensIn':
    case 'tokensOut':
    case 'cacheRead':
    case 'cacheWrite':
      return formatCount(value);
    case 'durationMs':
      return formatDuration(value);
    case 'turns':
    case 'checklist':
      return formatPlain(Math.round(value * 10) / 10);
  }
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function TaskBreakdown() {
  const { index } = useReport();
  const { results } = index;
  const metrics = METRIC_ORDER.filter((metric) =>
    results.breakdown.some((row) => row.means[metric] !== undefined),
  );
  const tasks = results.experiment.taskIds;
  return (
    <section aria-labelledby="tasks-heading">
      <div className="section-head">
        <h2 id="tasks-heading">Tasks</h2>
      </div>
      <p className="quiet">
        Mean per run, for each task under each arm. Select a task to see its runs.
      </p>
      <div className="table-scroll">
        <table className="data breakdown">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Arm</th>
              <th scope="col" className="num">
                Runs
              </th>
              {metrics.map((metric) => (
                <th key={metric} scope="col" className="num">
                  {sentenceCase(METRICS[metric].label)}
                </th>
              ))}
            </tr>
          </thead>
          {tasks.map((taskId) => {
            const rows = results.breakdown.filter((row) => row.taskId === taskId);
            const dead = index.dead.has(taskId);
            return (
              <tbody key={taskId} className={dead ? 'task-group dead' : 'task-group'}>
                {rows.map((row, i) => (
                  <tr key={row.arm}>
                    {i === 0 && (
                      <th scope="rowgroup" rowSpan={rows.length} className="task-cell">
                        <a href={toHash({ view: 'runs', filter: { task: taskId } })}>{taskId}</a>
                        {dead && <span className="tag">dead task</span>}
                      </th>
                    )}
                    <td>
                      <ArmLabel name={row.arm} />
                    </td>
                    <td className="num">{row.runCount}</td>
                    {metrics.map((metric) => {
                      const value = row.means[metric];
                      return (
                        <td key={metric} className="num">
                          {value === undefined || value === null ? (
                            <span className="none" aria-label="no value">
                              –
                            </span>
                          ) : (
                            formatMean(metric, value)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {dead && (
                  <tr className="note-row">
                    <td colSpan={3 + metrics.length}>{DEAD_TASK_NOTE}</td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
    </section>
  );
}
