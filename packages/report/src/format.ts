// Formatting only the report needs. Every number the terminal also prints comes from
// `@placebo-eval/core/format`, so both print the same strings.

/** A timestamp in UTC, to the minute: `2026-09-27 14:03 UTC`. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
