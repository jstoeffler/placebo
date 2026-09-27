import { METRICS, type MetricRow, type MetricUnit, type Verdict } from '../domain/metrics.js';
import { RUNS_NEEDED_CAP } from './metric-row.js';

const UNIT_SUFFIX: Readonly<Record<MetricUnit, string>> = {
  pts: ' pts',
  percent: ' %',
  absolute: '',
};

const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  helps: 'helps',
  harms: 'harms',
  placebo: 'placebo',
  no_evidence: 'no evidence',
};

/**
 * A row's difference with sign and unit, as printed on the terminal card and in the report:
 * `-7 pts`, `-18 %`, `-1.2`, `+0.3`. See {@link formatSigned} for the precision.
 */
export function formatDifference(row: Pick<MetricRow, 'metric' | 'difference'>): string {
  const { unit } = METRICS[row.metric];
  return formatSigned(row.difference, unit) + UNIT_SUFFIX[unit];
}

/** A row's range without unit, e.g. `[-30, +15]`. */
export function formatRange(row: Pick<MetricRow, 'metric' | 'range'>): string {
  const { unit } = METRICS[row.metric];
  const [low, high] = row.range;
  return `[${formatSigned(low, unit)}, ${formatSigned(high, unit)}]`;
}

/** `helps`, `harms`, `placebo` or `no evidence`. */
export function formatVerdict(verdict: Verdict): string {
  return VERDICT_LABELS[verdict];
}

/**
 * The runs-needed note of a `no_evidence` row: `12` or `more than 1000` (runs per task);
 * `undefined` on other rows and on rows with no task.
 */
export function formatRunsNeeded(
  row: Pick<MetricRow, 'verdict' | 'runsNeeded' | 'taskCount'>,
): string | undefined {
  if (row.verdict !== 'no_evidence' || row.taskCount === 0) return undefined;
  return row.runsNeeded === undefined
    ? `more than ${String(RUNS_NEEDED_CAP)}`
    : String(row.runsNeeded);
}

/**
 * A number with an explicit sign (`+` or `-`, none for zero) and a precision that suits its
 * unit: `pts` and `percent` are whole numbers, with one decimal below 10 in magnitude; `absolute`
 * keeps at most two decimals from 1 up, and two significant digits below 1. Trailing zeros are
 * dropped, so `-7` rather than `-7.0`.
 */
export function formatSigned(value: number, unit: MetricUnit): string {
  const magnitude = Math.abs(value);
  const digits = decimals(magnitude, unit);
  const text = trimZeros(magnitude.toFixed(digits));
  if (text === '0') return '0';
  return (value < 0 ? '-' : '+') + text;
}

function decimals(magnitude: number, unit: MetricUnit): number {
  if (unit !== 'absolute') return magnitude < 10 ? 1 : 0;
  if (magnitude >= 1 || magnitude === 0) return 2;
  return Math.min(20, 1 - Math.floor(Math.log10(magnitude)));
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}
