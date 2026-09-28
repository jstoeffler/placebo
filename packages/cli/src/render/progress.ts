import {
  formatCurrency,
  formatDuration,
  type ProgressEvent,
  type Reporter,
  type Run,
} from '@placebo-eval/core';
import type { Colors } from './colors.js';

export interface ProgressOptions {
  readonly write: (text: string) => void;
  /** A terminal gets updating status lines; anything else one plain line per event. */
  readonly tty: boolean;
  readonly colors: Colors;
  /** Printed with the experiment id so any experiment can be replayed. */
  readonly seed: number;
  /** Milliseconds, for elapsed times. */
  readonly now: () => number;
  /** Terminal width; status lines are cut to fit so they never wrap. */
  readonly columns?: number;
  /** Prints warnings only. */
  readonly quiet?: boolean;
  /** How often a terminal redraws elapsed times; 0 never. */
  readonly refreshMs?: number;
}

interface ActiveRun {
  readonly label: string;
  readonly startedAt: number;
  grading: boolean;
}

/**
 * Renders progress events. On a terminal, one updating status line per run in flight (task · arm
 * · run n · elapsed) sits above a running count (`12/40 runs · $3.21 so far`), and everything
 * else scrolls above them. Elsewhere, such as CI, each event is one plain line.
 *
 * Cost comes from the runs as they are saved (`recordRun`), since progress events carry none.
 */
export class ProgressRenderer implements Reporter {
  readonly #options: ProgressOptions;
  readonly #labels = new Map<string, string>();
  readonly #active = new Map<string, ActiveRun>();
  readonly #costs = new Map<string, number>();
  #totalRuns = 0;
  #finishedRuns = 0;
  #liveLines = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ProgressOptions) {
    this.#options = options;
  }

  /** Spend so far: agent cost plus judge cost of every saved run. */
  get costUsd(): number {
    let total = 0;
    for (const cost of this.#costs.values()) total += cost;
    return total;
  }

  /** Records the cost of a saved run; saving the same run again replaces it. */
  recordRun(run: Run): void {
    let cost = run.measurements.costUsd;
    for (const { detail } of run.grades) {
      if (detail.type === 'judge' || detail.type === 'comparison') cost += detail.spend.costUsd;
    }
    this.#costs.set(run.id, cost);
  }

  report(event: ProgressEvent): void {
    const { colors } = this.#options;
    if (event.type === 'message') {
      const text =
        event.level === 'warn' ? `${colors.yellow('warning:')} ${event.text}` : event.text;
      this.#print([text]);
      return;
    }
    if (this.#options.quiet === true) return;
    const lines = this.#linesFor(event);
    this.#print(lines);
  }

  /** Stops redrawing and clears the status lines. */
  close(): void {
    this.#stopTimer();
    this.#active.clear();
    this.#print([]);
  }

  #linesFor(event: Exclude<ProgressEvent, { type: 'message' }>): string[] {
    const { colors, tty } = this.#options;
    switch (event.type) {
      case 'snapshot_ready':
        return [
          `snapshot ${event.snapshotId} ${event.cached === true ? 'ready (cached)' : 'ready'}`,
        ];
      case 'experiment_started':
        this.#totalRuns = event.totalRuns;
        if (tty) this.#startTimer();
        return [
          `experiment ${colors.bold(event.experimentId)} · seed ${String(this.#options.seed)} · ${String(event.totalRuns)} runs`,
        ];
      case 'run_started': {
        const label = `${event.taskId} · ${event.arm} · run ${runNumber(event.runId)}`;
        this.#labels.set(event.runId, label);
        this.#active.set(event.runId, { label, startedAt: this.#options.now(), grading: false });
        return tty ? [] : [`started  ${label}`];
      }
      case 'run_retried':
        return [
          `${colors.yellow('retry')}    ${this.#label(event.runId)} · attempt ${String(event.attempt)} failed (${event.reason}) · next in ${formatDuration(event.delayMs)}`,
        ];
      case 'grading_started': {
        const active = this.#active.get(event.runId);
        if (active !== undefined) active.grading = true;
        return tty ? [] : [`grading  ${this.#label(event.runId)}`];
      }
      case 'run_finished': {
        const active = this.#active.get(event.runId);
        this.#active.delete(event.runId);
        this.#finishedRuns += 1;
        const elapsed =
          active === undefined
            ? ''
            : ` · ${formatDuration(this.#options.now() - active.startedAt)}`;
        const outcome =
          event.outcome === 'completed'
            ? colors.green(event.outcome)
            : colors.red(event.outcome.replaceAll('_', ' '));
        return [`finished ${this.#label(event.runId)} · ${outcome}${elapsed} · ${this.#count()}`];
      }
      case 'comparisons_started':
        return [
          `comparing ${event.treatment} with control on ${event.taskId} · ${String(event.pairs)} judge ${event.pairs === 1 ? 'call' : 'calls'}`,
        ];
      case 'experiment_finished':
        this.#stopTimer();
        this.#active.clear();
        return [
          `experiment finished · ${String(event.completedRuns)}/${String(event.totalRuns)} runs in ${formatDuration(event.durationMs)} · ${formatCurrency(this.costUsd)}`,
        ];
      default:
        return [];
    }
  }

  #label(runId: string): string {
    return this.#labels.get(runId) ?? runId;
  }

  #count(): string {
    return `${String(this.#finishedRuns)}/${String(this.#totalRuns)} runs · ${formatCurrency(this.costUsd)} so far`;
  }

  /** Prints `lines` above the status lines, then redraws them (terminal) or just prints. */
  #print(lines: readonly string[]): void {
    const { write, tty } = this.#options;
    if (!tty) {
      if (lines.length > 0) write(lines.map((line) => `${line}\n`).join(''));
      return;
    }
    const clear = this.#liveLines > 0 ? `\x1b[${String(this.#liveLines)}A\r\x1b[J` : '';
    const live = this.#statusLines();
    this.#liveLines = live.length;
    write(clear + [...lines, ...live].map((line) => `${line}\n`).join(''));
  }

  #statusLines(): string[] {
    if (this.#active.size === 0) return [];
    const { colors, now } = this.#options;
    const width = Math.max(20, (this.#options.columns ?? 80) - 1);
    const lines = [...this.#active.values()].map((run) => {
      const state = run.grading ? ' · grading' : '';
      return colors.dim(
        cut(`  ${run.label} · ${formatDuration(now() - run.startedAt)}${state}`, width),
      );
    });
    lines.push(cut(this.#count(), width));
    return lines;
  }

  #startTimer(): void {
    const refreshMs = this.#options.refreshMs ?? 1000;
    if (refreshMs <= 0 || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      if (this.#active.size > 0) this.#print([]);
    }, refreshMs);
    this.#timer.unref();
  }

  #stopTimer(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** The run number from a run id, `<experiment>-<task>-<arm>-<n>`. */
function runNumber(runId: string): string {
  return /-(\d+)$/.exec(runId)?.[1] ?? '?';
}

function cut(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
