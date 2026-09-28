import type { ExperimentId, ProgressEvent, RunId, TaskId, VariantName } from '@placebo-eval/core';
import { makeRun } from '@placebo-eval/core/testing';
import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { ProgressRenderer } from './progress.js';

const EXPERIMENT = '20260927-100000-00000007' as ExperimentId;
const RUN = `${EXPERIMENT}-refund-none-2` as RunId;
const TASK = 'refund' as TaskId;
const NONE = 'none' as VariantName;

function renderer(tty: boolean, extra: { quiet?: boolean; columns?: number } = {}) {
  let out = '';
  let clock = 0;
  const progress = new ProgressRenderer({
    write: (text) => (out += text),
    tty,
    colors: pc.createColors(false),
    seed: 7,
    now: () => clock,
    refreshMs: 0,
    ...extra,
  });
  return {
    progress,
    advance: (ms: number) => (clock += ms),
    take: () => {
      const text = out;
      out = '';
      return text;
    },
  };
}

const EVENTS: readonly ProgressEvent[] = [
  { type: 'message', level: 'warn', text: 'the judge model is the subject model' },
  { type: 'message', level: 'info', text: 'stopping after runs in flight' },
  { type: 'snapshot_ready', snapshotId: 'abc-123', cached: true },
  { type: 'experiment_started', experimentId: EXPERIMENT, totalRuns: 4 },
  { type: 'run_started', runId: RUN, taskId: TASK, arm: NONE },
  { type: 'run_retried', runId: RUN, attempt: 1, reason: 'rate_limited', delayMs: 2000 },
  { type: 'grading_started', runId: RUN },
  { type: 'run_finished', runId: RUN, outcome: 'completed' },
  { type: 'comparisons_started', taskId: TASK, treatment: NONE, pairs: 1 },
  {
    type: 'experiment_finished',
    experimentId: EXPERIMENT,
    completedRuns: 4,
    totalRuns: 4,
    durationMs: 64_000,
  },
];

describe('ProgressRenderer, plain', () => {
  it('prints one line per event', () => {
    const { progress, advance, take } = renderer(false);
    const lines: string[] = [];
    for (const event of EVENTS) {
      if (event.type === 'run_finished') {
        advance(12_300);
        progress.recordRun(makeRun({ id: RUN, measurements: { costUsd: 1.5 } }));
      }
      progress.report(event);
      lines.push(take());
    }
    expect(lines).toEqual([
      'warning: the judge model is the subject model\n',
      'stopping after runs in flight\n',
      'snapshot abc-123 ready (cached)\n',
      `experiment ${EXPERIMENT} · seed 7 · 4 runs\n`,
      'started  refund · none · run 2\n',
      'retry    refund · none · run 2 · attempt 1 failed (rate_limited) · next in 2.0 s\n',
      'grading  refund · none · run 2\n',
      expect.stringMatching(
        /^finished refund · none · run 2 · completed · 12\.3 s · 1\/4 runs · \$1\.5\d so far\n$/,
      ),
      'comparing none with control on refund · 1 judge call\n',
      expect.stringMatching(/^experiment finished · 4\/4 runs in 1 m 04 s · \$1\.5\d\n$/),
    ]);
  });

  it('counts agent and judge spend per run, replacing a run saved again', () => {
    const { progress } = renderer(false);
    progress.recordRun(makeRun({ id: RUN, measurements: { costUsd: 1 }, grades: [] }));
    const judged = makeRun({ id: RUN, measurements: { costUsd: 1 } });
    progress.recordRun(judged);
    const judgeSpend = judged.grades.reduce(
      (sum, { detail }) =>
        sum + (detail.type === 'judge' || detail.type === 'comparison' ? detail.spend.costUsd : 0),
      0,
    );
    expect(judgeSpend).toBeGreaterThan(0);
    expect(progress.costUsd).toBeCloseTo(1 + judgeSpend);
  });

  it('names outcomes other than completed', () => {
    const { progress, take } = renderer(false);
    progress.report({ type: 'run_finished', runId: RUN, outcome: 'stopped_by_permission_denial' });
    expect(take()).toContain(`${RUN} · stopped by permission denial · 1/0 runs`);
  });

  it('prints only warnings when quiet', () => {
    const { progress, take } = renderer(false, { quiet: true });
    for (const event of EVENTS) progress.report(event);
    expect(take()).toBe(
      'warning: the judge model is the subject model\nstopping after runs in flight\n',
    );
  });
});

describe('ProgressRenderer, terminal', () => {
  it('keeps one status line per run in flight above the running count', () => {
    const { progress, advance, take } = renderer(true, { columns: 200 });
    progress.report({ type: 'experiment_started', experimentId: EXPERIMENT, totalRuns: 4 });
    expect(take()).toBe(`experiment ${EXPERIMENT} · seed 7 · 4 runs\n`);

    progress.report({ type: 'run_started', runId: RUN, taskId: TASK, arm: NONE });
    expect(take()).toBe('  refund · none · run 2 · 0.0 s\n0/4 runs · $0.00 so far\n');

    advance(1500);
    progress.report({ type: 'grading_started', runId: RUN });
    // Moves up over the two status lines, clears them, redraws.
    expect(take()).toBe(
      '\x1b[2A\r\x1b[J  refund · none · run 2 · 1.5 s · grading\n0/4 runs · $0.00 so far\n',
    );

    progress.report({ type: 'message', level: 'warn', text: 'careful' });
    expect(take()).toBe(
      '\x1b[2A\r\x1b[Jwarning: careful\n  refund · none · run 2 · 1.5 s · grading\n0/4 runs · $0.00 so far\n',
    );

    progress.report({
      type: 'run_retried',
      runId: RUN,
      attempt: 2,
      reason: 'network',
      delayMs: 500,
    });
    expect(take()).toContain('retry    refund · none · run 2 · attempt 2 failed (network)');

    progress.report({ type: 'snapshot_ready', snapshotId: 's' });
    expect(take()).toContain('snapshot s ready\n');

    progress.report({ type: 'run_finished', runId: RUN, outcome: 'failed' });
    expect(take()).toBe(
      '\x1b[2A\r\x1b[Jfinished refund · none · run 2 · failed · 1.5 s · 1/4 runs · $0.00 so far\n',
    );

    progress.report({ type: 'comparisons_started', taskId: TASK, treatment: NONE, pairs: 3 });
    expect(take()).toBe('comparing none with control on refund · 3 judge calls\n');

    progress.report({
      type: 'experiment_finished',
      experimentId: EXPERIMENT,
      completedRuns: 1,
      totalRuns: 4,
      durationMs: 2000,
    });
    expect(take()).toBe('experiment finished · 1/4 runs in 2.0 s · $0.00\n');
  });

  it('cuts status lines to the terminal width and clears them on close', () => {
    const { progress, take } = renderer(true, { columns: 24 });
    progress.report({ type: 'run_started', runId: RUN, taskId: TASK, arm: NONE });
    expect(take()).toBe('  refund · none · run …\n0/0 runs · $0.00 so far\n');
    progress.close();
    expect(take()).toBe('\x1b[2A\r\x1b[J');
  });

  it('redraws elapsed times on a timer while runs are in flight', async () => {
    let out = '';
    const progress = new ProgressRenderer({
      write: (text) => (out += text),
      tty: true,
      colors: pc.createColors(false),
      seed: 1,
      now: () => 0,
      refreshMs: 5,
    });
    progress.report({ type: 'experiment_started', experimentId: EXPERIMENT, totalRuns: 1 });
    progress.report({ type: 'run_started', runId: RUN, taskId: TASK, arm: NONE });
    out = '';
    await new Promise((resolve) => setTimeout(resolve, 30));
    progress.close();
    expect(out).toContain('\x1b[2A\r\x1b[J  refund · none · run 2 · 0.0 s\n');
  });
});
