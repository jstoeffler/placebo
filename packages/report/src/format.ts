import type { MetricUnit } from '@placebo-eval/core/results';

// Number formatting shared by the verdict card, tables and run detail. The terminal card in core
// follows the same rules; the two must print identical strings for the same numbers.

/** Rounds to `decimals` places, turning -0 into 0. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function signed(value: number, text: string): string {
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

/**
 * The magnitude of a signed number in a unit, without the sign or unit label.
 * `pts` and `percent`: an integer when the absolute value is 10 or more, else one decimal.
 * `absolute`: at most two decimals, trailing zeros dropped.
 */
function magnitude(
  value: number,
  unit: MetricUnit,
): { readonly rounded: number; readonly text: string } {
  if (unit === 'absolute') {
    const rounded = round(value, 2);
    return { rounded, text: String(Math.abs(rounded)) };
  }
  const oneDecimal = round(value, 1);
  if (Math.abs(oneDecimal) >= 10) {
    const rounded = round(value, 0);
    return { rounded, text: String(Math.abs(rounded)) };
  }
  return { rounded: oneDecimal, text: Math.abs(oneDecimal).toFixed(1) };
}

/** A signed number without a unit label, as used inside ranges: `-30`, `+15`, `-2.6`, `0`. */
function formatSigned(value: number, unit: MetricUnit): string {
  const { rounded, text } = magnitude(value, unit);
  return signed(rounded, text);
}

const UNIT_LABEL: Readonly<Record<MetricUnit, string>> = {
  pts: ' pts',
  percent: ' %',
  absolute: '',
};

/** A difference with explicit sign and unit: `-7.0 pts`, `-18 %`, `-1.2`. */
export function formatDifference(value: number, unit: MetricUnit): string {
  return `${formatSigned(value, unit)}${UNIT_LABEL[unit]}`;
}

/** A range as `[lo, hi]` with signs and no unit: `[-30, +15]`. */
export function formatRange(range: readonly [number, number], unit: MetricUnit): string {
  return `[${formatSigned(range[0], unit)}, ${formatSigned(range[1], unit)}]`;
}

/** Above this many runs per task, the card says "more than" instead of a number. */
const RUNS_NEEDED_CAP = 1000;

/** The runs-needed note of a no-evidence row: `(≈12 runs/task to decide)`. */
export function formatRunsNeeded(runsNeeded: number): string {
  if (runsNeeded > RUNS_NEEDED_CAP) return `(more than ${String(RUNS_NEEDED_CAP)} runs/task)`;
  return `(≈${String(runsNeeded)} runs/task to decide)`;
}

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const currency = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** US dollars with two decimals and comma grouping: `$0.42`, `$1,204.00`. */
export function formatCurrency(usd: number): string {
  return `$${currency.format(round(usd, 2))}`;
}

/** A count with comma grouping: `12,345`. Fractions are rounded. */
export function formatCount(value: number): string {
  return grouped.format(round(value, 0));
}

/** A plain number with at most two decimals, trailing zeros dropped: `3.2`, `14`. */
export function formatPlain(value: number): string {
  return String(round(value, 2));
}

/** A share in [0, 1] as a percentage, at most one decimal: `60 %`, `0 %`, `8.3 %`. */
export function formatShare(share: number): string {
  return `${String(round(share * 100, 1))} %`;
}

/** A duration: `0.8 s`, `12.3 s`, `1 m 04 s`, `2 h 03 m`. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (round(seconds, 1) < 60) return `${round(seconds, 1).toFixed(1)} s`;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${String(hours)} h ${pad(minutes)} m`;
  return `${String(minutes)} m ${pad(secs)} s`;
}

/** A byte size: `812 B`, `4.2 KB`, `1.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** A timestamp in UTC, to the minute: `2026-09-27 14:03 UTC`. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
