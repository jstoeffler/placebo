import {
  type ExcludedTask,
  METRICS,
  MIN_RUNS_PER_ARM,
  type Metric,
  type MetricRow,
  type MetricUnit,
  type Verdict,
} from '../domain/metrics.js';
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

/** What a row with no task left prints in place of its difference and its range. */
const NO_ESTIMATE = '-';

/**
 * A row's difference with sign and unit, as printed on the terminal card and in the report:
 * `-7 pts`, `-18 %`, `-1.2`, `+0.3`. See {@link formatSigned} for the precision. A row with no
 * task left (`taskCount` 0) has no difference and prints `-`.
 */
export function formatDifference(
  row: Pick<MetricRow, 'metric' | 'difference'> & Partial<Pick<MetricRow, 'taskCount'>>,
): string {
  if (row.taskCount === 0) return NO_ESTIMATE;
  const { unit } = METRICS[row.metric];
  return formatSigned(row.difference, unit) + UNIT_SUFFIX[unit];
}

/** A row's range without unit, e.g. `[-30, +15]`; `-` like {@link formatDifference}. */
export function formatRange(
  row: Pick<MetricRow, 'metric' | 'range'> & Partial<Pick<MetricRow, 'taskCount'>>,
): string {
  if (row.taskCount === 0) return NO_ESTIMATE;
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
 * The runs-needed note of a `no_evidence` row as the card prints it, `(≈12 runs/task to decide)`
 * or `(more than 1000 runs/task)`. A row with no task left because tasks had too few runs says
 * `(at least 2 runs/task to compute a range)`. `undefined` on every other row.
 */
export function formatRunsNeededNote(
  row: Pick<MetricRow, 'verdict' | 'runsNeeded' | 'taskCount'>,
): string | undefined {
  if (row.verdict === 'no_evidence' && row.taskCount === 0 && row.runsNeeded !== undefined) {
    return `(at least ${String(row.runsNeeded)} runs/task to compute a range)`;
  }
  const runs = formatRunsNeeded(row);
  if (runs === undefined) return undefined;
  return row.runsNeeded === undefined ? `(${runs} runs/task)` : `(≈${runs} runs/task to decide)`;
}

const EXCLUSION_REASONS: Readonly<Record<ExcludedTask['reason'], string>> = {
  control_zero: 'control is zero',
  too_few_runs: `fewer than ${String(MIN_RUNS_PER_ARM)} runs`,
};

/**
 * The tasks a row leaves out, with why, as the card prints it under the row:
 * `left out: refund (fewer than 2 runs), totals (control is zero)`. `undefined` when none, and
 * when every task was left out for too few runs, which the runs-needed note already says.
 */
export function formatExcludedTasks(
  row: Pick<MetricRow, 'excludedTasks' | 'taskCount'>,
): string | undefined {
  const excluded = row.excludedTasks ?? [];
  const thinOnly = excluded.every((task) => task.reason === 'too_few_runs');
  if (excluded.length === 0 || (row.taskCount === 0 && thinOnly)) return undefined;
  const items = excluded.map((task) => `${task.taskId} (${EXCLUSION_REASONS[task.reason]})`);
  return `left out: ${items.join(', ')}`;
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

const DOLLARS = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** US dollars with two decimals and comma grouping: `$0.42`, `$1,204.00`. */
export function formatCurrency(usd: number): string {
  return `$${DOLLARS.format(usd === 0 ? 0 : usd)}`;
}

/** A token count, rounded to a whole number, with comma grouping: `12,345`. */
export function formatTokens(count: number): string {
  return GROUPED.format(Math.round(count));
}

/**
 * A duration in ms: seconds with one decimal under a minute (`0.8 s`, `12.3 s`), then minutes and
 * padded seconds (`1 m 04 s`), then hours and padded minutes (`2 h 03 m`).
 */
export function formatDuration(ms: number): string {
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${String(hours)} h ${pad(minutes)} m`;
  return `${String(minutes)} m ${pad(seconds % 60)} s`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Rounds to `decimals` places, turning -0 into 0. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** A plain number with at most two decimals, trailing zeros dropped: `3.2`, `14`. */
export function formatPlain(value: number): string {
  return String(round(value, 2));
}

/** A share in [0, 1] as a percentage, at most one decimal: `60 %`, `0 %`, `8.3 %`. */
export function formatShare(share: number): string {
  return `${String(round(share * 100, 1))} %`;
}

/** A byte size: `812 B`, `4.2 KB`, `1.3 MB`, `2.1 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/**
 * A per-run mean of a metric in the metric's own unit, as the per-task tables print it: shares
 * for pass rate and win rate, dollars, token counts, durations, and plain numbers with one
 * decimal for turns and checklist.
 */
export function formatMean(metric: Metric, value: number): string {
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
      return formatTokens(value);
    case 'durationMs':
      return formatDuration(value);
    case 'turns':
    case 'checklist':
      return formatPlain(round(value, 1));
  }
}
