import { describe, expect, it } from 'vitest';
import { MetricRow, type Metric } from '../domain/metrics.js';
import { Margins } from '../domain/suite.js';
import { TaskId } from '../kernel/ids.js';
import { createSeededRandom, type Random } from '../kernel/random.js';
import {
  computeMetricRow,
  decideVerdict,
  estimateRunsNeeded,
  RUNS_NEEDED_CAP,
  type TaskSamples,
} from './metric-row.js';

const margins = Margins.parse({});

function task(id: string, control: number[], treatment: number[]): TaskSamples {
  return { taskId: TaskId.parse(id), control, treatment };
}

/** The same per-arm samples on `count` tasks. */
function tasks(count: number, control: number[], treatment: number[]): TaskSamples[] {
  return Array.from({ length: count }, (_, i) => task(`t${String(i)}`, control, treatment));
}

function row(metric: Metric, samples: TaskSamples[], seed = 1, resamples?: number): MetricRow {
  const result = computeMetricRow({
    metric,
    tasks: samples,
    margins,
    random: createSeededRandom(seed),
    ...(resamples === undefined ? {} : { resamples }),
  });
  return MetricRow.parse(result);
}

describe('computeMetricRow: known scenarios', () => {
  it('identical constant arms give difference 0 and placebo when the metric has a margin', () => {
    const r = row('costUsd', tasks(3, [0.2, 0.2, 0.2], [0.2, 0.2, 0.2]));
    expect(r).toMatchObject({ difference: 0, range: [0, 0], verdict: 'placebo', margin: 10 });
    expect(r.runsNeeded).toBeUndefined();
    expect(row('passRate', tasks(3, [1, 1], [1, 1])).verdict).toBe('placebo');
  });

  it('identical arms give no_evidence for metrics without a margin', () => {
    const r = row('turns', tasks(3, [4, 4], [4, 4]));
    expect(r).toMatchObject({ difference: 0, range: [0, 0], verdict: 'no_evidence', margin: null });
    expect(r.runsNeeded).toBeUndefined();
  });

  it('a clearly better pass rate is helps, with a positive difference in pts', () => {
    const r = row('passRate', tasks(5, [0, 0, 1, 0, 0], [1, 1, 1, 1, 0]));
    expect(r.difference).toBeCloseTo(60);
    expect(r.verdict).toBe('helps');
    expect(r.range[0]).toBeGreaterThan(0);
    expect(r).toMatchObject({ taskCount: 5, runCount: 50 });
  });

  it('a clearly worse pass rate is harms, with a negative difference', () => {
    const r = row('passRate', tasks(5, [1, 1, 1, 1, 0], [0, 0, 1, 0, 0]));
    expect(r.difference).toBeCloseTo(-60);
    expect(r.verdict).toBe('harms');
    expect(r.range[1]).toBeLessThan(0);
  });

  it('a lower cost is helps and a higher cost is harms (lower is better)', () => {
    const cheaper = row('costUsd', tasks(4, [1, 1.1, 0.9], [0.5, 0.55, 0.45]));
    expect(cheaper.difference).toBeCloseTo(-50);
    expect(cheaper.verdict).toBe('helps');
    const dearer = row('costUsd', tasks(4, [0.5, 0.55, 0.45], [1, 1.1, 0.9]));
    expect(dearer.difference).toBeCloseTo(100);
    expect(dearer.verdict).toBe('harms');
  });

  it('a range that excludes zero is helps even when it sits inside the margin', () => {
    const r = row('costUsd', tasks(3, [1, 1], [0.98, 0.98]));
    expect(r.difference).toBeCloseTo(-2);
    expect(r.verdict).toBe('helps');
  });

  it('absolute metrics take the plain difference of means', () => {
    const r = row('turns', [task('a', [4, 6], [2, 2]), task('b', [10, 10], [9, 9])]);
    expect(r.difference).toBeCloseTo(-2);
  });

  it('never gives a verdict from one run per arm: every task is left out as too few runs', () => {
    for (const metric of ['passRate', 'costUsd', 'turns'] as const) {
      const r = row(metric, [task('a', [0.1], [0.2]), task('b', [1], [0])]);
      expect(r).toEqual({
        metric,
        difference: 0,
        range: [0, 0],
        verdict: 'no_evidence',
        margin: metric === 'turns' ? null : metric === 'costUsd' ? 10 : 5,
        runsNeeded: 2,
        taskCount: 0,
        runCount: 0,
        excludedTasks: [
          { taskId: 'a', reason: 'too_few_runs' },
          { taskId: 'b', reason: 'too_few_runs' },
        ],
      });
    }
  });

  it('needs two runs in the control arm too, not only in the treatment', () => {
    const r = row('costUsd', [task('a', [0.1], [0.2, 0.2])]);
    expect(r.excludedTasks).toEqual([{ taskId: 'a', reason: 'too_few_runs' }]);
    expect(r.verdict).toBe('no_evidence');
  });

  it('gives a range from two runs per arm', () => {
    const r = row('costUsd', [task('a', [0.1, 0.12], [0.2, 0.22])]);
    expect(r.taskCount).toBe(1);
    expect(r.runCount).toBe(4);
    expect(r.excludedTasks).toBeUndefined();
    expect(r.range[0]).toBeLessThan(r.range[1]);
    expect(r.range[0]).toBeLessThanOrEqual(r.difference);
    expect(r.range[1]).toBeGreaterThanOrEqual(r.difference);
  });

  it('leaves out only the thin tasks when tasks have different run counts', () => {
    const r = row('turns', [
      task('thin', [4], [2, 2]),
      task('a', [4, 6], [2, 2]),
      task('b', [10, 10], [9, 9]),
    ]);
    expect(r.excludedTasks).toEqual([{ taskId: 'thin', reason: 'too_few_runs' }]);
    expect(r).toMatchObject({ taskCount: 2, runCount: 8 });
    expect(r.difference).toBeCloseTo(-2);
  });

  it('counts only treatment runs toward the minimum for win rate', () => {
    const r = row('winRate', [task('thin', [], [1]), task('a', [], [1, 1]), task('b', [], [1, 0])]);
    expect(r.excludedTasks).toEqual([{ taskId: 'thin', reason: 'too_few_runs' }]);
    expect(r.taskCount).toBe(2);
  });

  it('with one task draws runs only and still gives a range', () => {
    const r = row('passRate', [task('a', [0, 1, 0, 1], [1, 0, 1, 1])]);
    expect(r.difference).toBeCloseTo(25);
    expect(r.range[0]).toBeLessThan(0);
    expect(r.range[1]).toBeGreaterThan(25);
    expect(r.verdict).toBe('no_evidence');
    expect(r.runsNeeded).toBeGreaterThan(4);
  });

  it('leaves out percent tasks whose control mean is zero and lists them', () => {
    const r = row('cacheWrite', [
      task('zero', [0, 0], [50, 70]),
      task('a', [100, 100], [110, 110]),
      task('b', [100, 100], [110, 110]),
    ]);
    expect(r.excludedTasks).toEqual([{ taskId: 'zero', reason: 'control_zero' }]);
    expect(r.taskCount).toBe(2);
    expect(r.runCount).toBe(8);
    expect(r.difference).toBeCloseTo(10);
  });

  it('gives no_evidence with no task when every task is left out', () => {
    const r = row('cacheWrite', [task('zero', [0, 0], [5, 5])]);
    expect(r).toEqual({
      metric: 'cacheWrite',
      difference: 0,
      range: [0, 0],
      verdict: 'no_evidence',
      margin: 10,
      taskCount: 0,
      runCount: 0,
      excludedTasks: [{ taskId: 'zero', reason: 'control_zero' }],
    });
  });

  it('skips tasks where an arm has no value, without listing them as excluded', () => {
    const r = row('checklist', [task('a', [], [3]), task('b', [2, 2], [3, 3])]);
    expect(r.taskCount).toBe(1);
    expect(r.excludedTasks).toBeUndefined();
  });

  it('compares win rate with 50 % using treatment runs only', () => {
    const allWins = row('winRate', tasks(3, [], [1, 1, 1, 1]));
    expect(allWins).toMatchObject({ difference: 50, verdict: 'helps', runCount: 12 });
    const allLosses = row('winRate', tasks(3, [], [0, 0, 0]));
    expect(allLosses).toMatchObject({ difference: -50, verdict: 'harms' });
    const even = row('winRate', tasks(3, [], [1, 0, 1, 0]));
    expect(even.difference).toBe(0);
    expect(even.verdict).toBe('no_evidence');
  });

  it('ignores control values for win rate', () => {
    const withControl = row('winRate', tasks(2, [0, 0, 0], [1, 0, 1]));
    const without = row('winRate', tasks(2, [], [1, 0, 1]));
    expect(withControl).toEqual(without);
  });

  it('rejects a resample count that is not a positive integer', () => {
    expect(() => row('turns', tasks(1, [1], [2]), 1, 0)).toThrow(RangeError);
    expect(() => row('turns', tasks(1, [1], [2]), 1, 2.5)).toThrow(RangeError);
  });
});

/** Noisy but reproducible samples: `runs` values around `centre`. */
function noisy(random: Random, runs: number, centre: number, spread: number): number[] {
  return Array.from({ length: runs }, () => centre + (random.next() - 0.5) * 2 * spread);
}

describe('computeMetricRow: properties', () => {
  it('keeps the difference inside its range in 100 seeded trials', () => {
    for (let seed = 0; seed < 100; seed++) {
      const data = createSeededRandom(seed + 1000);
      const taskCount = data.int(1, 6);
      const samples = Array.from({ length: taskCount }, (_, i) =>
        task(
          `t${String(i)}`,
          noisy(data, data.int(1, 6), 10, 5),
          noisy(data, data.int(1, 6), 11, 5),
        ),
      );
      const r = row('turns', samples, seed, 200);
      expect(r.range[0]).toBeLessThanOrEqual(r.difference);
      expect(r.range[1]).toBeGreaterThanOrEqual(r.difference);
    }
  });

  it('gives the same range for the same seed', () => {
    const samples = tasks(4, [1, 3, 2, 5], [2, 4, 4, 6]);
    expect(row('turns', samples, 7)).toEqual(row('turns', samples, 7));
  });

  it('gives a slightly different range but the same verdict with another seed', () => {
    const samples = tasks(5, [0, 0, 1, 0, 0], [1, 1, 1, 1, 0]);
    const a = row('passRate', samples, 1);
    const b = row('passRate', samples, 2);
    expect(a.range).not.toEqual(b.range);
    expect(Math.abs(a.range[0] - b.range[0])).toBeLessThan(10);
    expect(Math.abs(a.range[1] - b.range[1])).toBeLessThan(10);
    expect(a.verdict).toBe(b.verdict);
  });

  it('never changes the difference with the resample count', () => {
    const samples = [task('a', [1, 3, 2], [2, 4, 4]), task('b', [5, 5], [3, 4])];
    const few = row('turns', samples, 1, 10);
    const many = row('turns', samples, 1, 3000);
    expect(few.difference).toBe(many.difference);
  });
});

describe('decideVerdict', () => {
  it('reads the good side from the direction of the metric', () => {
    expect(decideVerdict([1, 2], true, null)).toBe('helps');
    expect(decideVerdict([1, 2], false, null)).toBe('harms');
    expect(decideVerdict([-2, -1], true, null)).toBe('harms');
    expect(decideVerdict([-2, -1], false, null)).toBe('helps');
  });

  it('gives placebo only to ranges touching or crossing zero inside the margin', () => {
    expect(decideVerdict([0, 3], true, 5)).toBe('placebo');
    expect(decideVerdict([-5, 5], true, 5)).toBe('placebo');
    expect(decideVerdict([-6, 1], true, 5)).toBe('no_evidence');
    expect(decideVerdict([-1, 1], true, null)).toBe('no_evidence');
    expect(decideVerdict([0.5, 1], true, 5)).toBe('helps');
  });
});

describe('estimateRunsNeeded', () => {
  it('follows the 1/√n formula to exclude zero', () => {
    // half-width 4, difference 2, 5 runs: n > 5 · (4/2)² = 20.
    expect(
      estimateRunsNeeded({ difference: 2, range: [-2, 6], margin: null, runsPerTask: 5 }),
    ).toBe(21);
  });

  it('takes the margin when it is reached first', () => {
    // margin: n ≥ 5 · (4 / (5 − 2))² = 8.9, before 21 to exclude zero.
    expect(estimateRunsNeeded({ difference: 2, range: [-2, 6], margin: 5, runsPerTask: 5 })).toBe(
      9,
    );
  });

  it('needs more runs for a wider range', () => {
    let previous = 0;
    for (const halfWidth of [3, 4, 6, 9, 12]) {
      const needed = estimateRunsNeeded({
        difference: 2,
        range: [2 - halfWidth, 2 + halfWidth],
        margin: 5,
        runsPerTask: 5,
      });
      expect(needed).toBeGreaterThan(previous);
      previous = needed ?? Number.POSITIVE_INFINITY;
    }
  });

  it('asks for at least one more run than already done', () => {
    // Symmetric extrapolation would already exclude zero; the asymmetric range did not.
    expect(
      estimateRunsNeeded({ difference: 5, range: [-1, 6], margin: null, runsPerTask: 5 }),
    ).toBe(6);
  });

  it('is undefined above the cap or when no verdict can be reached', () => {
    const huge = { difference: 1, range: [-100, 100] as [number, number], margin: null };
    expect(estimateRunsNeeded({ ...huge, runsPerTask: 5 })).toBeUndefined();
    expect(
      estimateRunsNeeded({ difference: 0, range: [-1, 1], margin: null, runsPerTask: 5 }),
    ).toBeUndefined();
    expect(estimateRunsNeeded({ difference: 6, range: [-1, 13], margin: 5, runsPerTask: 5 })).toBe(
      Math.floor(5 * (7 / 6) ** 2) + 1,
    );
    expect(
      estimateRunsNeeded({ difference: 0, range: [0, 0], margin: 5, runsPerTask: 5 }),
    ).toBeUndefined();
    expect(RUNS_NEEDED_CAP).toBe(1000);
  });

  it('is only set on no_evidence rows', () => {
    const decided = row('passRate', tasks(5, [0, 0, 1, 0, 0], [1, 1, 1, 1, 0]));
    expect(decided.runsNeeded).toBeUndefined();
    const undecided = row('turns', tasks(2, [1, 5, 3], [2, 6, 3]));
    expect(undecided.verdict).toBe('no_evidence');
    expect(undecided.runsNeeded).toBeGreaterThan(3);
  });
});
