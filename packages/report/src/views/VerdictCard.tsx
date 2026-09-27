import {
  METRICS,
  type MetricRow,
  type Results,
  type VerdictCard as Card,
} from '@placebo-eval/core/results';
import { ArmLabel } from '../context.js';
import { orderedRows } from '../data/model.js';
import {
  formatDifference,
  formatRange,
  formatRunsNeededNote,
  formatVerdict,
} from '@placebo-eval/core/format';

/** The header line of a card, as in brief §5. */
function cardMeta(results: Results): string {
  const { experiment } = results;
  return [
    '',
    `${String(experiment.runsPerTask)} runs × ${String(experiment.taskIds.length)} tasks`,
    `model ${experiment.pins.subjectModel}`,
    `claude code ${experiment.pins.claudeCodeVersion}`,
  ].join(' · ');
}

export function VerdictCard({ card, results }: { readonly card: Card; readonly results: Results }) {
  const rows = orderedRows(card.rows);
  const titleId = `card-${card.variant}`;
  return (
    <section className="card" aria-labelledby={titleId}>
      <h2 id={titleId} className="card-title">
        <span className="card-arm">
          <ArmLabel name={card.variant} />
        </span>{' '}
        vs control<span className="card-meta">{cardMeta(results)}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="quiet">No metric has data for this treatment.</p>
      ) : (
        <table className="card-rows">
          <thead className="visually-hidden">
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Difference</th>
              <th scope="col">Range</th>
              <th scope="col">Range against zero and margin</th>
              <th scope="col">Verdict</th>
              <th scope="col">Runs needed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <MetricLine key={row.metric} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function MetricLine({ row }: { readonly row: MetricRow }) {
  const info = METRICS[row.metric];
  return (
    <tr className={`verdict-${row.verdict}`} data-metric={row.metric}>
      <th scope="row" className="metric">
        {info.label}
      </th>
      <td className="num difference">{formatDifference(row)}</td>
      <td className="num range">{formatRange(row)}</td>
      <td className="gauge-cell">
        <Gauge row={row} />
      </td>
      <td className="verdict">
        <span className="verdict-word">{formatVerdict(row.verdict)}</span>
      </td>
      <td className="runs-needed">{formatRunsNeededNote(row)}</td>
    </tr>
  );
}

const WIDTH = 168;
const HEIGHT = 20;
const PAD = 6;

/**
 * The range drawn against zero and the margin band, on a scale of its own. Decorative for
 * screen readers: the difference, range and verdict are all in the text of the row.
 */
function Gauge({ row }: { readonly row: MetricRow }) {
  const [lo, hi] = row.range;
  const extent = Math.max(Math.abs(lo), Math.abs(hi), row.margin ?? 0, 1e-9) * 1.08;
  const x = (value: number) => PAD + ((value + extent) / (2 * extent)) * (WIDTH - 2 * PAD);
  const mid = HEIGHT / 2;
  return (
    <svg
      className="gauge"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      aria-hidden="true"
      focusable="false"
    >
      <line className="gauge-axis" x1={PAD} x2={WIDTH - PAD} y1={mid} y2={mid} />
      {row.margin !== null && (
        <rect
          className="gauge-margin"
          x={x(-row.margin)}
          width={x(row.margin) - x(-row.margin)}
          y={mid - 6}
          height={12}
        />
      )}
      <line className="gauge-zero" x1={x(0)} x2={x(0)} y1={2} y2={HEIGHT - 2} />
      <line className="gauge-range" x1={x(lo)} x2={Math.max(x(hi), x(lo) + 1)} y1={mid} y2={mid} />
      <circle className="gauge-point" cx={x(row.difference)} cy={mid} r={3.5} />
    </svg>
  );
}
