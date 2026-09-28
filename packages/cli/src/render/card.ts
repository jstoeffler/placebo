import {
  describeWarning,
  formatDifference,
  formatExcludedTasks,
  formatMean,
  formatRange,
  formatRunsNeededNote,
  formatVerdict,
  METRICS,
  type Metric,
  type Results,
  type Verdict,
  type VerdictCard,
  type Warning,
} from '@placebo-eval/core';
import type { Colors } from './colors.js';

/** Column widths of the brief §5 card; a column widens when a value does not fit. */
const TITLE_WIDTH = 27;
const LABEL_WIDTH = 14;
const DIFFERENCE_WIDTH = 10;
const RANGE_WIDTH = 15;
const VERDICT_WIDTH = 14;
const HEADER_GAP = '    ';

const METRIC_ORDER = Object.keys(METRICS) as Metric[];

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

/** At least `min`, and wide enough for the longest value plus `gap` spaces. */
function widthOf(values: readonly string[], min: number, gap: number): number {
  return Math.max(min, ...values.map((value) => value.length + gap));
}

function colorVerdict(colors: Colors, verdict: Verdict, text: string): string {
  switch (verdict) {
    case 'helps':
      return colors.green(text);
    case 'harms':
      return colors.red(text);
    case 'placebo':
      return colors.cyan(text);
    case 'no_evidence':
      return colors.dim(text);
  }
}

/**
 * One verdict card in the brief §5 layout: the header line (treatment vs control, runs × tasks,
 * subject model, Claude Code version), then one row per metric in card order with the label,
 * difference, range, verdict word and, on `no evidence` rows, the runs-needed note, and under a
 * row the tasks it leaves out. Colour only decorates; the words carry the meaning.
 */
export function renderCard(card: VerdictCard, results: Results, colors: Colors): string {
  const { experiment } = results;
  const title = `${card.variant} vs control`;
  const header = [
    title + ' '.repeat(Math.max(HEADER_GAP.length, TITLE_WIDTH - title.length)),
    [
      `${plural(experiment.runsPerTask, 'run')} × ${plural(experiment.taskIds.length, 'task')}`,
      `model ${experiment.pins.subjectModel}`,
      `claude code ${experiment.pins.claudeCodeVersion}`,
    ].join(HEADER_GAP),
  ].join('');
  const rows = [...card.rows].sort(
    (a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric),
  );
  if (rows.length === 0) return `${colors.bold(header)}\n  no metric has data for this treatment\n`;

  const cells = rows.map((row) => ({
    row,
    label: METRICS[row.metric].label,
    difference: formatDifference(row),
    range: formatRange(row),
    verdict: formatVerdict(row.verdict),
    note: formatRunsNeededNote(row),
    excluded: formatExcludedTasks(row),
  }));
  const labelWidth = widthOf(
    cells.map((cell) => cell.label),
    LABEL_WIDTH,
    2,
  );
  const differenceWidth = widthOf(
    cells.map((cell) => cell.difference),
    DIFFERENCE_WIDTH,
    2,
  );
  const rangeWidth = widthOf(
    cells.map((cell) => cell.range),
    RANGE_WIDTH,
    3,
  );
  const lines = cells.map((cell) => {
    const verdict =
      cell.note === undefined ? cell.verdict : pad(cell.verdict, VERDICT_WIDTH) + cell.note;
    const line = `  ${pad(cell.label, labelWidth)}${pad(cell.difference, differenceWidth)}${pad(cell.range, rangeWidth)}${colorVerdict(colors, cell.row.verdict, verdict)}`;
    return cell.excluded === undefined
      ? line
      : `${line}\n  ${' '.repeat(labelWidth)}${colors.dim(cell.excluded)}`;
  });
  return `${colors.bold(header)}\n${lines.join('\n')}\n`;
}

/** Columns of the per-task table, as means per run from the results' breakdown. */
const TABLE_METRICS: readonly Metric[] = ['passRate', 'costUsd', 'turns', 'durationMs'];

/**
 * The per-task table: one line per task and arm with runs, pass rate, cost, turns and duration,
 * each a mean per run formatted by core. `-` marks a metric with no value.
 */
export function renderTaskTable(results: Results, colors: Colors): string {
  const header = ['task', 'arm', 'runs', ...TABLE_METRICS.map((metric) => METRICS[metric].label)];
  const body: string[][] = [];
  for (const taskId of results.experiment.taskIds) {
    const dead = results.deadTasks.includes(taskId);
    const rows = results.breakdown.filter((row) => row.taskId === taskId);
    rows.forEach((row, index) => {
      body.push([
        index === 0 ? `${taskId}${dead ? ' (dead)' : ''}` : '',
        row.arm,
        String(row.runCount),
        ...TABLE_METRICS.map((metric) => {
          const value = row.means[metric];
          return value === undefined || value === null ? '-' : formatMean(metric, value);
        }),
      ]);
    });
  }
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => (cells[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => {
        const width = widths[column] ?? 0;
        return column < 2 ? cell.padEnd(width) : cell.padStart(width);
      })
      .join('  ')
      .trimEnd();
  return `${colors.bold(line(header))}\n${body.map(line).join('\n')}\n`;
}

/**
 * One sentence per warning, dead tasks included, each once: the warnings the results carry,
 * plus a dead-task sentence for any dead task they do not already name.
 */
export function warningSentences(results: Pick<Results, 'warnings' | 'deadTasks'>): string[] {
  const warnings: Warning[] = [...results.warnings];
  for (const taskId of results.deadTasks) {
    if (!warnings.some((warning) => warning.type === 'dead_task' && warning.taskId === taskId)) {
      warnings.push({ type: 'dead_task', taskId });
    }
  }
  return [...new Set(warnings.map(describeWarning))];
}

/** Everything printed after an experiment: cards, the per-task table, then warnings. */
export function renderResults(results: Results, colors: Colors): string {
  const parts = results.verdictCards.map((card) => renderCard(card, results, colors));
  parts.push(renderTaskTable(results, colors));
  const warnings = warningSentences(results);
  if (warnings.length > 0) {
    parts.push(warnings.map((text) => `${colors.yellow('warning:')} ${text}`).join('\n') + '\n');
  }
  return parts.join('\n');
}
