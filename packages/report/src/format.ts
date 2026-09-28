// Formatting only the report needs. Differences, ranges, verdicts, runs needed, currency, tokens
// and durations come from `@placebo-eval/core/format`, shared with the terminal card.

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
